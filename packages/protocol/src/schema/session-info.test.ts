// SessionInfo says why a session ended (review WEB-12): a session the host terminated must not look like a normal
// exit ("exit code 0") to its owner.
import { describe, expect, it } from 'vitest';
import { SESSION_END_REASONS, SESSION_KINDS, hostSettingsPatchSchema, hostSettingsSchema, publicSettingsSchema, sessionInfoSchema } from './entities.ts';
import { sessionCreatePayloadSchema } from './messages/sessions.ts';

const exited = {
  id: 'ses_abc',
  kind: 'agent',
  ownerUserId: 'dev:amy',
  ownerName: 'Amy',
  title: 'Claude',
  sandboxed: true,
  root: { kind: 'main' },
  status: 'exited',
  exitCode: 0,
  cols: 80,
  rows: 24,
  createdAt: 1_760_000_000_000,
  endedAt: 1_760_000_060_000,
  login: 'logged-in',
  attached: 0,
} as const;

describe('SessionInfo end reason', () => {
  it('carries who ended the session and why', () => {
    const parsed = sessionInfoSchema.parse({ ...exited, endReason: 'terminated', endedBy: { userId: 'dev:ian', displayName: 'Ian 老師' } });
    expect(parsed).toMatchObject({ endReason: 'terminated', endedBy: { userId: 'dev:ian', displayName: 'Ian 老師' } });
  });

  it('is optional (older daemons) and refuses unknown reasons or extra keys', () => {
    expect(sessionInfoSchema.safeParse(exited).success).toBe(true);
    expect(sessionInfoSchema.safeParse({ ...exited, endReason: 'crashed' }).success).toBe(false);
    expect(sessionInfoSchema.safeParse({ ...exited, endReason: 'ended', endedBy: { userId: 'dev:amy', displayName: 'Amy', role: 'host' } }).success).toBe(false);
  });

  it('uses the same words as the daemon', () => {
    expect([...SESSION_END_REASONS]).toEqual(['exit', 'ended', 'terminated', 'kicked', 'left', 'role-changed', 'stopped']);
  });
});

// ARCHITECTURE §11 D-12: a guest's own Claude subscription login is a session of kind 'login'; whether guests may start
// one is published to every member (PublicSettings.guestSubscriptionLogin) but is not a console setting.
describe('the guest subscription login (D-12)', () => {
  it('is a session kind of its own, in session.create and in SessionInfo', () => {
    expect([...SESSION_KINDS]).toEqual(['agent', 'terminal', 'login']);
    expect(sessionInfoSchema.parse({ ...exited, kind: 'login', sandboxed: true, login: 'unknown' }).kind).toBe('login');
    expect(sessionCreatePayloadSchema.safeParse({ kind: 'login', workspace: { mode: 'main' }, cols: 100, rows: 30 }).success).toBe(true);
    // The command is the daemon's: there is no field for it.
    expect(sessionCreatePayloadSchema.safeParse({ kind: 'login', workspace: { mode: 'main' }, cols: 100, rows: 30, args: ['--console'] }).success).toBe(false);
    expect(sessionCreatePayloadSchema.safeParse({ kind: 'login', workspace: { mode: 'main' }, cols: 100, rows: 30, env: { BROWSER: 'x' } }).success).toBe(false);
  });

  it('PublicSettings may say whether guests may use it; HostSettings (admin.settings.*) cannot carry it', () => {
    const base = { humanLockIdleMs: 30_000, agentLockTimeoutMs: 60_000, uploadChunkSize: 4 * 1024 * 1024, sharedDirs: [] };
    expect(publicSettingsSchema.parse({ ...base, guestSubscriptionLogin: false }).guestSubscriptionLogin).toBe(false);
    expect(publicSettingsSchema.parse(base).guestSubscriptionLogin).toBeUndefined();
    expect(publicSettingsSchema.safeParse({ ...base, guestSubscriptionLogin: 'no' }).success).toBe(false);
    const host = { ...base, allowedDomains: [], diskReserveBytes: 1, diskReservePercent: 5 };
    expect(hostSettingsSchema.safeParse(host).success).toBe(true);
    expect(hostSettingsSchema.safeParse({ ...host, guestSubscriptionLogin: true }).success).toBe(false);
    expect(hostSettingsPatchSchema.safeParse({ guestSubscriptionLogin: false }).success).toBe(false);
  });
});

// ARCHITECTURE §11 D-14 (owner decision 2026-10-01): whether guests may use the shared main workspace is the daemon's
// configuration (off by default on a Linux host), published to every member, never a console setting.
describe('guests in the main workspace (D-14)', () => {
  const base = { humanLockIdleMs: 30_000, agentLockTimeoutMs: 60_000, uploadChunkSize: 4 * 1024 * 1024, sharedDirs: [] };

  it('PublicSettings may say it (true / false / not said), only as a boolean', () => {
    expect(publicSettingsSchema.parse({ ...base, guestMainWorkspace: false }).guestMainWorkspace).toBe(false);
    expect(publicSettingsSchema.parse({ ...base, guestMainWorkspace: true }).guestMainWorkspace).toBe(true);
    expect(publicSettingsSchema.parse(base).guestMainWorkspace).toBeUndefined();
    expect(publicSettingsSchema.parse({ ...base, guestSubscriptionLogin: true, guestMainWorkspace: false })).toEqual({ ...base, guestSubscriptionLogin: true, guestMainWorkspace: false });
    for (const bad of ['no', 0, 1, null]) expect(publicSettingsSchema.safeParse({ ...base, guestMainWorkspace: bad }).success).toBe(false);
  });

  it('HostSettings and admin.settings.set cannot carry it (the console cannot open the main workspace to guests)', () => {
    const host = { ...base, allowedDomains: [], diskReserveBytes: 1, diskReservePercent: 5 };
    expect(hostSettingsSchema.safeParse({ ...host, guestMainWorkspace: false }).success).toBe(false);
    expect(hostSettingsPatchSchema.safeParse({ guestMainWorkspace: true }).success).toBe(false);
  });
});
