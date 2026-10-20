// What protocol 5 added (smurg 0.6.0, DESIGN D3, D4, D5): smurg's own four permission modes, models as opaque ids of
// the agent's own list, the host's agent and work state, the topic's agent settings, the Start dialog's history and the
// update's notice. Every new message has samples in message-samples.fixture.ts (run by registry.test.ts); this file
// holds the rules that a sample alone does not say.
import { describe, expect, it } from 'vitest';
import {
  HOST_NOTICES,
  MODE_FALLBACKS,
  WORK_HISTORIES,
  agentHostStateSchema,
  agentModelSchema,
  agentSessionSchema,
  hostStateSchema,
  publicSettingsSchema,
  workStateSchema,
} from './entities.ts';
import { ATTENTION_SUBJECTS, inboxItemSchema, inboxKindWaits } from './inbox.ts';
import { MODEL_ID_MAX_CHARS } from './limits.ts';
import { agentModels, agentsAutoItem, directHostState, hostState, itemSession, preflight, publicSettings, topic } from './message-samples.fixture.ts';
import { welcomeSchema } from './handshake.ts';
import { topicAgentSetPayloadSchema } from './messages/topics.ts';
import { modelIdSchema } from './primitives.ts';
import { NO_CHANGES_REASONS, START_HISTORIES, startPreflightSchema, topicSchema } from './topics.ts';

describe('a model is an opaque id of the agent\'s own list (D4)', () => {
  it('aliases, full ids, cloud ids and pinned versions pass; nothing that could be read as a flag, a path or a second argument does', () => {
    for (const id of ['sonnet', 'sonnet[1m]', 'claude-opus-5-5', 'claude-haiku-4-5-20251001', 'arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-opus-5-5', 'claude-opus-5-5@20261001', 'opus+fast', 'm'.repeat(MODEL_ID_MAX_CHARS)]) {
      expect(modelIdSchema.safeParse(id).success, id).toBe(true);
    }
    for (const id of ['', '-p', '--model', ' sonnet', 'sonnet ', 'a b', 'sonnet;rm', 'a\nb', '$(id)', 'ü', '.hidden', '/abs', 'm'.repeat(MODEL_ID_MAX_CHARS + 1)]) {
      expect(modelIdSchema.safeParse(id).success, JSON.stringify(id)).toBe(false);
    }
  });

  it('a list entry: its value, name, line and whether auto mode runs with it; `billing` says only usage credits', () => {
    for (const entry of agentModels) expect(agentModelSchema.safeParse(entry).success, entry.value).toBe(true);
    const opus = agentModels[0] as (typeof agentModels)[number];
    expect(agentModelSchema.safeParse({ ...opus, auto: undefined }).success).toBe(false);
    expect(agentModelSchema.safeParse({ ...opus, resolved: undefined }).success).toBe(true);
    expect(agentModelSchema.safeParse({ ...opus, billing: 'usage-credits' }).success).toBe(true);
    expect(agentModelSchema.safeParse({ ...opus, billing: 'free' }).success).toBe(false);
    expect(agentModelSchema.safeParse({ ...opus, description: 'x'.repeat(513) }).success).toBe(false);
    expect(agentModelSchema.safeParse({ ...opus, description: 'a\u0007b' }).success).toBe(false);
    expect(agentModelSchema.safeParse({ ...opus, supportsAutoMode: true }).success).toBe(false);
  });

  it('the host agent\'s state: not known yet is an empty list and no default', () => {
    expect(agentHostStateSchema.safeParse({ models: [], modelsKnown: false, hostDefault: null, autoMode: 'ok', asksNothing: 'ok' }).success).toBe(true);
    expect(agentHostStateSchema.safeParse({ ...hostState.agent, autoMode: 'auto' }).success).toBe(false);
    for (const asksNothing of ['ok', 'off', 'root']) expect(agentHostStateSchema.safeParse({ ...hostState.agent, asksNothing }).success, asksNothing).toBe(true);
  });
});

describe('the permission mode of a session (D3)', () => {
  it('what runs differs from what smurg asked only with a reason, and only once something was reported', () => {
    expect([...MODE_FALLBACKS]).toEqual(['model-no-auto', 'auto-off', 'ask-nothing-off']);
    expect(agentSessionSchema.safeParse(itemSession).success).toBe(true);
    expect(agentSessionSchema.safeParse({ ...itemSession, modeInUse: undefined, modeFallback: undefined }).success).toBe(true);
    expect(agentSessionSchema.safeParse({ ...itemSession, modeInUse: undefined }).success).toBe(false);
  });

  it('every member learns the workspace\'s mode in the Welcome: a protocol 4 Welcome (settings without it) is refused', () => {
    const welcome = {
      channelId: 'ch_1',
      resumed: false,
      member: { userId: 'dev:ian', displayName: 'Ian', role: 'host', color: '#ff8800', online: true, joinedAt: 1 },
      workspace: { id: 'AbCdEfGh_-012345', name: 'Smurg', hostUserId: 'dev:ian', hostName: 'Ian', platform: 'darwin', isGitRepo: false },
      settings: publicSettings,
      serverTime: 1,
    };
    expect(welcomeSchema.safeParse(welcome).success).toBe(true);
    const { permissionMode: _gone, ...protocol4 } = publicSettings;
    expect(publicSettingsSchema.safeParse(protocol4).success).toBe(false);
    expect(welcomeSchema.safeParse({ ...welcome, settings: protocol4 }).success).toBe(false);
  });
});

describe('how work items run here (D5)', () => {
  it('four histories; only `direct` carries a reason', () => {
    expect([...WORK_HISTORIES]).toEqual(['folder', 'smurg', 'direct', 'unchecked']);
    for (const history of WORK_HISTORIES) expect(workStateSchema.safeParse({ history }).success, history).toBe(true);
    expect(workStateSchema.safeParse(directHostState.work).success).toBe(true);
    expect(workStateSchema.safeParse({ ...directHostState.work, history: 'smurg' }).success).toBe(false);
    expect(hostStateSchema.safeParse(directHostState).success).toBe(true);
  });

  it('the Start dialog names how the items started now run; the commit only with the folder\'s own repository', () => {
    expect([...START_HISTORIES]).toEqual(['folder', 'smurg', 'direct']);
    expect(startPreflightSchema.safeParse(preflight).success).toBe(true);
    expect(startPreflightSchema.safeParse({ ...preflight, history: 'smurg' }).success).toBe(false); // a commit with smurg's own history
    expect(startPreflightSchema.safeParse({ ...preflight, history: 'smurg', commit: null }).success).toBe(true);
    expect(startPreflightSchema.safeParse({ ...preflight, history: 'smurg', commit: null, nestedRepos: ['frontend', 'tools/vendor'], cloudSynced: true }).success).toBe(true);
    expect(startPreflightSchema.safeParse({ ...preflight, history: 'direct', commit: null, direct: { reason: preflight.blockers[0], hostOnly: false } }).success).toBe(true);
    expect(startPreflightSchema.safeParse({ ...preflight, history: 'direct', commit: null, direct: { reason: preflight.blockers[0] } }).success).toBe(false);
    expect(startPreflightSchema.safeParse({ ...preflight, nestedRepos: ['/abs'], history: 'smurg', commit: null }).success).toBe(false);
  });

  it('a report of an item that ran directly in the folder has no changes to review: `no-history`', () => {
    expect(NO_CHANGES_REASONS).toContain('no-history');
  });
});

describe('a topic\'s agent settings (D3, D4)', () => {
  it('every topic says them; null is the host\'s default model and the workspace\'s mode', () => {
    expect(topicSchema.safeParse(topic).success).toBe(true);
    expect(topicSchema.safeParse({ ...topic, agent: undefined }).success).toBe(false);
    expect(topicSchema.safeParse({ ...topic, agent: { model: null, permissionMode: null } }).success).toBe(true);
    expect(topicSchema.safeParse({ ...topic, agent: { model: null, permissionMode: 'ask-nothing' } }).success).toBe(false);
  });

  it('topic.agent.set sets at least one of the two', () => {
    expect(topicAgentSetPayloadSchema.safeParse({ topicId: 'tp_1' }).success).toBe(false);
    expect(topicAgentSetPayloadSchema.safeParse({ topicId: 'tp_1', model: null }).success).toBe(true);
    expect(topicAgentSetPayloadSchema.safeParse({ topicId: 'tp_1', permissionMode: null }).success).toBe(true);
  });
});

describe('the update\'s notice (D13)', () => {
  it('is an attention item of the host\'s that stops no work and opens the console\'s settings', () => {
    expect([...HOST_NOTICES]).toEqual(['agents-auto']);
    expect(ATTENTION_SUBJECTS).toContain('agents-auto');
    expect(inboxKindWaits('attention', 'agents-auto')).toBe(false);
    expect(inboxItemSchema.safeParse(agentsAutoItem).success).toBe(true);
    expect(inboxItemSchema.safeParse({ ...agentsAutoItem, waiting: true }).success).toBe(false);
  });
});
