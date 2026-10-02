// SessionInfo says why a session ended: a session the host terminated must not look like a normal
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

// ARCHITECTURE §11 D-15 (owner decision 2026-10-01): no guest sandbox, no guest login process, no guest API key, no
// guest switches. Every session runs like the host's own; SessionInfo names who opened it (ownerUserId / ownerName).
describe('no guest sandbox (D-15)', () => {
  const base = { humanLockIdleMs: 30_000, agentLockTimeoutMs: 60_000, uploadChunkSize: 4 * 1024 * 1024, sharedDirs: [] };

  it('sessions are agents or terminals; SessionInfo has no sandboxed flag', () => {
    expect([...SESSION_KINDS]).toEqual(['agent', 'terminal']);
    expect(sessionInfoSchema.safeParse({ ...exited, kind: 'login' }).success).toBe(false);
    expect(sessionInfoSchema.safeParse({ ...exited, sandboxed: false }).success).toBe(false);
    expect(sessionInfoSchema.parse({ ...exited, kind: 'terminal' })).toMatchObject({ kind: 'terminal', ownerUserId: 'dev:amy', ownerName: 'Amy' });
  });

  it('session.create carries no API key, no login kind and nothing that could choose a sandbox', () => {
    const create = { kind: 'agent', workspace: { mode: 'main' }, cols: 100, rows: 30 };
    expect(sessionCreatePayloadSchema.safeParse(create).success).toBe(true);
    expect(sessionCreatePayloadSchema.safeParse({ ...create, kind: 'login' }).success).toBe(false);
    expect(sessionCreatePayloadSchema.safeParse({ ...create, apiKey: 'sk-ant-api03-x' }).success).toBe(false);
    expect(sessionCreatePayloadSchema.safeParse({ ...create, sandboxed: true }).success).toBe(false);
  });

  it('settings carry no guest switches and no network allow-list', () => {
    expect(publicSettingsSchema.safeParse(base).success).toBe(true);
    expect(publicSettingsSchema.safeParse({ ...base, guestSubscriptionLogin: false }).success).toBe(false);
    expect(publicSettingsSchema.safeParse({ ...base, guestMainWorkspace: true }).success).toBe(false);
    const host = { ...base, diskReserveBytes: 1, diskReservePercent: 5 };
    expect(hostSettingsSchema.safeParse(host).success).toBe(true);
    expect(hostSettingsSchema.safeParse({ ...host, allowedDomains: [] }).success).toBe(false);
    expect(hostSettingsPatchSchema.safeParse({ allowedDomains: ['pypi.org'] }).success).toBe(false);
    expect(hostSettingsPatchSchema.safeParse({ guestMainWorkspace: true }).success).toBe(false);
  });
});
