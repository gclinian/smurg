// SessionInfo (ARCHITECTURE §5.5): a union of terminal and agent sessions, discriminated by `kind`. It says who opened
// a session, and why and by whom it ended: a session the host terminated must not look like a normal exit.
import { describe, expect, it } from 'vitest';
import {
  AGENT_STATUSES,
  PERMISSION_MODES,
  SESSION_END_REASONS,
  SESSION_KINDS,
  agentSessionSchema,
  hostSettingsPatchSchema,
  hostSettingsSchema,
  publicSettingsSchema,
  sessionInfoSchema,
  terminalSessionSchema,
} from './entities.ts';
import { agentSession, itemSession } from './message-samples.fixture.ts';
import { sessionCreatePayloadSchema } from './messages/sessions.ts';

const exited = {
  id: 'ses_abc',
  kind: 'terminal',
  openedBy: { userId: 'dev:amy', displayName: 'Amy' },
  title: 'shell',
  root: { kind: 'main' },
  status: 'exited',
  exitCode: 0,
  cols: 80,
  rows: 24,
  createdAt: 1_760_000_000_000,
  endedAt: 1_760_000_060_000,
  attached: 0,
} as const;

describe('SessionInfo end reason', () => {
  it('carries who ended the session and why', () => {
    const parsed = sessionInfoSchema.parse({ ...exited, endReason: 'terminated', endedBy: { userId: 'dev:ian', displayName: 'Ian 老師' } });
    expect(parsed).toMatchObject({ endReason: 'terminated', endedBy: { userId: 'dev:ian', displayName: 'Ian 老師' } });
  });

  it('refuses unknown reasons and extra keys', () => {
    expect(sessionInfoSchema.safeParse(exited).success).toBe(true);
    expect(sessionInfoSchema.safeParse({ ...exited, endReason: 'crashed' }).success).toBe(false);
    expect(sessionInfoSchema.safeParse({ ...exited, endReason: 'ended', endedBy: { userId: 'dev:amy', displayName: 'Amy', role: 'host' } }).success).toBe(false);
  });

  it('uses the same words as the daemon', () => {
    expect([...SESSION_END_REASONS]).toEqual(['exit', 'ended', 'terminated', 'kicked', 'left', 'role-changed', 'stopped', 'worktree-removed', 'archived', 'replaced', 'merged']);
  });
});

describe('the union (protocol 4)', () => {
  it('a terminal has a size and viewers; it has no owner fields of protocol 3, no login and no conversation', () => {
    expect(terminalSessionSchema.parse(exited)).toMatchObject({ kind: 'terminal', openedBy: { userId: 'dev:amy' }, cols: 80, rows: 24 });
    expect(sessionInfoSchema.safeParse({ ...exited, ownerUserId: 'dev:amy', ownerName: 'Amy' }).success).toBe(false);
    expect(sessionInfoSchema.safeParse({ ...exited, login: 'logged-in' }).success).toBe(false);
    expect(sessionInfoSchema.safeParse({ ...exited, lastSeq: 3 }).success).toBe(false);
    expect(sessionInfoSchema.safeParse({ ...exited, status: 'idle' }).success).toBe(false);
  });

  it('an agent session is a conversation: no terminal size, no viewer count, no exit code', () => {
    expect(sessionInfoSchema.parse(agentSession)).toMatchObject({ kind: 'agent', purpose: 'discussion', responsible: null, modeFixed: true });
    expect(agentSessionSchema.parse(itemSession)).toMatchObject({ purpose: 'item', itemId: 'cart-api', responsible: { displayName: 'Amy' } });
    for (const extra of [{ cols: 80, rows: 24 }, { attached: 1 }, { exitCode: 0 }, { ownerUserId: 'dev:amy' }, { watchers: [] }, { hostRules: [] }, { usage: { costUsd: 1 } }]) {
      expect(sessionInfoSchema.safeParse({ ...agentSession, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('who is responsible is a person or nobody, never absent', () => {
    expect(agentSessionSchema.safeParse({ ...agentSession, responsible: undefined }).success).toBe(false);
    expect(agentSessionSchema.safeParse({ ...agentSession, responsible: 'dev:amy' }).success).toBe(false);
  });

  it('purpose, topic and item go together', () => {
    const free = { ...agentSession, purpose: 'free', topicId: undefined, topicName: undefined, modeFixed: false };
    expect(agentSessionSchema.safeParse(free).success).toBe(true);
    expect(agentSessionSchema.safeParse({ ...free, topicId: 'tp_1' }).success).toBe(false);
    expect(agentSessionSchema.safeParse({ ...agentSession, topicId: undefined }).success).toBe(false);
    expect(agentSessionSchema.safeParse({ ...agentSession, itemId: 'cart-api' }).success).toBe(false);
    expect(agentSessionSchema.safeParse({ ...itemSession, itemId: undefined }).success).toBe(false);
    expect(agentSessionSchema.safeParse({ ...itemSession, itemId: 'Cart API' }).success).toBe(false);
  });

  it('a topic session names its topic, an item session its item and attempt: a client names a session without loading anything else', () => {
    expect(agentSessionSchema.parse(agentSession)).toMatchObject({ topicId: 'tp_1', topicName: 'Checkout 結帳' });
    expect(agentSessionSchema.parse(itemSession)).toMatchObject({ item: { number: 1, title: 'Cart API' }, attempt: 1 });
    expect(agentSessionSchema.safeParse({ ...agentSession, topicName: undefined }).success).toBe(false);
    expect(agentSessionSchema.safeParse({ ...itemSession, item: undefined }).success).toBe(false);
    expect(agentSessionSchema.safeParse({ ...itemSession, attempt: undefined }).success).toBe(false);
    expect(agentSessionSchema.safeParse({ ...agentSession, attempt: 1 }).success).toBe(false);
    expect(agentSessionSchema.safeParse({ ...agentSession, item: { number: 1, title: 'Cart API' } }).success).toBe(false);
    // An item that left the plan keeps its title and has number 0.
    expect(agentSessionSchema.safeParse({ ...itemSession, item: { number: 0, title: 'Cart API' } }).success).toBe(true);
    // A title is only what a person gave: none of the two samples has one.
    expect(agentSessionSchema.parse(agentSession).title).toBeUndefined();
    expect(agentSessionSchema.parse(itemSession).title).toBeUndefined();
    expect(agentSessionSchema.parse(itemSession).runningSince).toBe(itemSession.runningSince);
  });

  it('statuses and permission modes are closed sets; there is no mode that asks for nothing', () => {
    expect([...AGENT_STATUSES]).toEqual(['starting', 'running', 'waiting-answer', 'waiting-permission', 'idle', 'stalled', 'done', 'failed', 'ended']);
    expect([...PERMISSION_MODES]).toEqual(['ask-all', 'ask-commands']);
    for (const mode of ['bypassPermissions', 'acceptEdits', 'default', 'ask-nothing']) {
      expect(agentSessionSchema.safeParse({ ...itemSession, permissionMode: mode }).success, mode).toBe(false);
    }
    expect(agentSessionSchema.safeParse({ ...itemSession, status: 'exited' }).success).toBe(false);
    expect(agentSessionSchema.safeParse({ ...itemSession, doing: 'thinking' }).success).toBe(false);
    expect(agentSessionSchema.safeParse({ ...itemSession, retryHostOnly: false }).success).toBe(false);
  });
});

// ARCHITECTURE §11 D-15 (owner decision 2026-10-01): no guest sandbox, no guest login process, no guest API key, no
// guest switches. Every session runs like the host's own; SessionInfo names who opened it (`openedBy`).
describe('no guest sandbox (D-15)', () => {
  const base = { humanLockIdleMs: 30_000, agentLockTimeoutMs: 60_000, uploadChunkSize: 4 * 1024 * 1024, sharedDirs: [] };

  it('sessions are agents or terminals; SessionInfo has no sandboxed flag', () => {
    expect([...SESSION_KINDS]).toEqual(['agent', 'terminal']);
    expect(sessionInfoSchema.safeParse({ ...exited, kind: 'login' }).success).toBe(false);
    expect(sessionInfoSchema.safeParse({ ...exited, sandboxed: false }).success).toBe(false);
    expect(sessionInfoSchema.safeParse({ ...agentSession, sandboxed: false }).success).toBe(false);
  });

  it('session.create carries no API key, no login kind, no model and nothing that could choose a sandbox or a permission bypass', () => {
    const create = { kind: 'agent', workspace: { mode: 'main' } };
    expect(sessionCreatePayloadSchema.safeParse(create).success).toBe(true);
    expect(sessionCreatePayloadSchema.safeParse({ ...create, kind: 'login' }).success).toBe(false);
    expect(sessionCreatePayloadSchema.safeParse({ ...create, apiKey: 'sk-ant-api03-x' }).success).toBe(false);
    expect(sessionCreatePayloadSchema.safeParse({ ...create, sandboxed: true }).success).toBe(false);
    expect(sessionCreatePayloadSchema.safeParse({ ...create, mode: 'ask-commands' }).success).toBe(false);
    expect(sessionCreatePayloadSchema.safeParse({ ...create, model: 'opus' }).success).toBe(false);
    expect(sessionCreatePayloadSchema.safeParse({ ...create, purpose: 'discussion', topicId: 'tp_1' }).success).toBe(false);
    expect(sessionCreatePayloadSchema.safeParse({ kind: 'terminal', workspace: { mode: 'main' }, cols: 100, rows: 30 }).success).toBe(true);
  });

  it('settings carry no guest switches and no network allow-list; the agent settings are host settings with ranges', () => {
    expect(publicSettingsSchema.safeParse(base).success).toBe(true);
    expect(publicSettingsSchema.safeParse({ ...base, guestSubscriptionLogin: false }).success).toBe(false);
    expect(publicSettingsSchema.safeParse({ ...base, guestMainWorkspace: true }).success).toBe(false);
    expect(publicSettingsSchema.safeParse({ ...base, maxLiveAgents: 8 }).success).toBe(false);
    const host = { ...base, diskReserveBytes: 1, diskReservePercent: 5, maxLiveAgents: 8, escalateAfterMs: 300_000, agentMcp: false };
    expect(hostSettingsSchema.safeParse(host).success).toBe(true);
    expect(hostSettingsSchema.safeParse({ ...host, allowedDomains: [] }).success).toBe(false);
    expect(hostSettingsSchema.safeParse({ ...host, maxLiveAgents: 1 }).success).toBe(false);
    expect(hostSettingsSchema.safeParse({ ...host, maxLiveAgents: 33 }).success).toBe(false);
    expect(hostSettingsSchema.safeParse({ ...host, escalateAfterMs: 59_000 }).success).toBe(false);
    expect(hostSettingsSchema.safeParse({ ...host, escalateAfterMs: 3_600_001 }).success).toBe(false);
    expect(hostSettingsPatchSchema.safeParse({ allowedDomains: ['pypi.org'] }).success).toBe(false);
    expect(hostSettingsPatchSchema.safeParse({ guestMainWorkspace: true }).success).toBe(false);
    expect(hostSettingsPatchSchema.safeParse({ agentMcp: true }).success).toBe(true);
  });
});
