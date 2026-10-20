// The persistent records of agent sessions (ARCHITECTURE §7.6 "The record"; DESIGN §2.2): what a later process start
// needs, never on the wire. One state document (`agent-sessions`); the role prompt, which is large and never changes,
// is a file next to the session's transcript (`role.md`, written once, sent byte for byte at every start).
//
// An agent session survives a daemon restart as an idle session (AD-10): a record that was not `ended` is loaded as
// idle (parked), whatever it was doing.
//
// 0.6.0 (DESIGN D6): a record keeps the session's own permission mode CHOICE (null: it follows its topic and the
// workspace) and its model (null: the host's default); 0.5.x records are read through the step from 0.5.0.
import { z } from 'zod';
import {
  AGENT_PURPOSES,
  SESSION_END_REASONS,
  SESSION_MODE_CHOICES,
  SMURG_TAG_PATTERN,
  displayNameSchema,
  epochMsSchema,
  itemIdSchema,
  messageOriginSchema,
  modelIdSchema,
  opaqueIdSchema,
  rememberedRuleSchema,
  rootRefSchema,
  shortTextSchema,
  smurgPurposeSchema,
  userIdSchema,
  userRefSchema,
} from '@smurg/protocol';
import type { PersistentDocument, StateStore } from '../../core/interfaces.ts';
import { declareDocument, defineStep, type DocumentStep } from '../../core/state-store.ts';
import { agentSessionsShapeV050, type AgentSessionsV050 } from '../../frozen/v0.5.0.ts';

export const AGENT_SESSIONS_DOCUMENT = 'agent-sessions';

/** Messages one record keeps for the next process; more than this many wait only as long as the daemon runs. */
export const PENDING_MESSAGES_MAX = 200;
/**
 * A message no turn has taken yet (ARCHITECTURE §7.6 "Runner"): what is written to the process (header + text) and what
 * the turn that takes it reports. Kept in the record so that it still waits after a restart of the daemon: the
 * conversation shows it as `queued` ("Claude reads it when it starts again"), and that stays true.
 */
const pendingMessageSchema = z.strictObject({
  messageId: opaqueIdSchema,
  text: z.string().min(1).max(4 * 1024 * 1024),
  turn: z.strictObject({
    messageId: opaqueIdSchema,
    kind: z.enum(['person', 'smurg']),
    origin: messageOriginSchema.optional(),
    from: userRefSchema.optional(),
    by: userRefSchema.optional(),
    purpose: smurgPurposeSchema.optional(),
    suggestionId: opaqueIdSchema.optional(),
  }),
  fromUserId: userIdSchema.nullable(),
});
export type PendingMessage = z.infer<typeof pendingMessageSchema>;

export const agentRecordSchema = z.strictObject({
  id: opaqueIdSchema,
  purpose: z.enum(AGENT_PURPOSES),
  topic: z.strictObject({ id: opaqueIdSchema, slug: z.string().min(1).max(64), name: z.string().min(1).max(256) }).optional(),
  item: z.strictObject({ id: itemIdSchema, number: z.int().min(0), title: z.string().min(1).max(256), attempt: z.int().min(1) }).optional(),
  openedBy: userRefSchema,
  /** The daemon-internal owner (whose locks the agent's are); passes to the host at a handover. */
  ownerUserId: userIdSchema,
  pathRights: z.enum(['member', 'host']),
  responsible: userRefSchema.nullable(),
  fallbackDecider: userIdSchema.nullable(),
  title: shortTextSchema.optional(),
  root: rootRefSchema,
  worktreeId: opaqueIdSchema.optional(),
  branch: shortTextSchema.optional(),
  /**
   * The session's own permission mode; null: it follows (a work item its topic's, then the workspace's). Never
   * `ask-nothing` (the host's, workspace-wide). (0.5.x's `mode` was renamed so that no 0.5.x record passes unchanged.)
   */
  modeChoice: z.enum(SESSION_MODE_CHOICES).nullable(),
  /** Who chose the mode (absent with null; the line `conversation.mode.reset` names them). */
  modeChangedBy: z.strictObject({ userId: userIdSchema, displayName: displayNameSchema }).optional(),
  /** The model chosen for the session (a value of the host agent's list); null: the host's default. */
  model: modelIdSchema.nullable(),
  /** Who chose the model (absent with null). */
  modelChangedBy: z.strictObject({ userId: userIdSchema, displayName: displayNameSchema }).optional(),
  rules: z.array(rememberedRuleSchema).max(200),
  /** Claude Code's own conversation id (a UUID): NOT smurg's session id. */
  claudeSessionId: z.uuid(),
  /** True after the first `result`: decides `--session-id` or `--resume`. */
  hasConversation: z.boolean(),
  /** smurg's turn numbers continue across processes. */
  turnCounter: z.int().min(0),
  smurgTag: z.string().regex(SMURG_TAG_PATTERN),
  /** Consecutive failed starts; three make "Try again" host-only. */
  startFailures: z.int().min(0),
  /** A turn started and no end was recorded (the daemon died meanwhile). */
  lastTurnOpen: z.boolean(),
  state: z.enum(['live', 'failed', 'ended']),
  itemState: z.strictObject({ reportRegistered: z.boolean(), stalled: z.enum(['agent', 'restart', 'stopped', 'error']).optional() }).optional(),
  /** The session started without its root's project settings; said once. */
  untrustedSaid: z.boolean(),
  createdAt: epochMsSchema,
  endedAt: epochMsSchema.optional(),
  endReason: z.enum(SESSION_END_REASONS).optional(),
  endedBy: userRefSchema.optional(),
  noteworthyAt: epochMsSchema,
  lastActivityAt: epochMsSchema,
  claudeVersion: z.string().max(40).optional(),
  /** Messages that wait for a turn, oldest first (absent: none). */
  pending: z.array(pendingMessageSchema).max(PENDING_MESSAGES_MAX).optional(),
});
export type AgentRecord = z.infer<typeof agentRecordSchema>;

const documentSchema = z.strictObject({ sessions: z.array(agentRecordSchema).max(10_000) });
type AgentDocument = z.infer<typeof documentSchema>;

/**
 * agent-sessions.json of smurg 0.5.0, 0.5.1 and 0.5.2 → 0.6.0 (with the state step: THE OWNER'S DECISION, 2026-10-20,
 * DECISIONS.md 2). A session follows the workspace (auto) unless a PERSON made it stricter than 0.5.2's default for
 * it: `ask-all` in a worktree (where 0.5.x ran every work item), with `modeChangedBy` (0.5.2's default there was
 * `ask-commands`).
 * That choice stays, and who made it. A main-workspace session that a person loosened to `ask-commands` follows auto,
 * which is what its person wanted more of. Every model is the host's default, as it was. Every record is carried;
 * nothing is dropped.
 */
export const agentSessionsStepFromV050: DocumentStep = defineStep({
  from: '0.5.0',
  sinceShapes: 2,
  shape: agentSessionsShapeV050,
  upgrade: (old: AgentSessionsV050) => ({
    sessions: old.sessions.map(({ mode, modeChangedBy, ...rest }) => {
      const tightened = rest.purpose !== 'discussion' && mode === 'ask-all' && modeChangedBy !== undefined && rest.root.kind === 'worktree';
      return { ...rest, modeChoice: tightened ? ('ask-all' as const) : null, ...(tightened ? { modeChangedBy } : {}), model: null };
    }),
  }),
});
/**
 * agent-sessions.json (no `version` key; new in 0.5.0). Declared by the sessions module.
 *
 * It CANNOT be set aside (no `canSetAside`; test/upgrade/set-aside.test.ts shows what a start without it leaves):
 * every topic still says its discussion is live and every started item still names its session, and none of those
 * sessions exists; a topic's discussion is only called lost when its session ends, never because it is not there.
 */
export const agentSessionsDocument = declareDocument({ name: AGENT_SESSIONS_DOCUMENT, schema: documentSchema, init: (): AgentDocument => ({ sessions: [] }), steps: [agentSessionsStepFromV050] });

/** The document's records, keyed by session id; every change is written through `save`. */
export class AgentStore {
  private readonly doc: PersistentDocument<AgentDocument>;

  private constructor(doc: PersistentDocument<AgentDocument>) {
    this.doc = doc;
  }

  static async open(state: StateStore): Promise<AgentStore> {
    return new AgentStore(await state.document(agentSessionsDocument.name, agentSessionsDocument.schema, agentSessionsDocument.init));
  }

  all(): AgentRecord[] {
    return this.doc.get().sessions.map((record) => structuredClone(record) as AgentRecord);
  }

  save(record: AgentRecord): void {
    this.doc.update((draft) => {
      const at = draft.sessions.findIndex((entry) => entry.id === record.id);
      if (at === -1) draft.sessions.push(structuredClone(record));
      else draft.sessions[at] = structuredClone(record);
    });
  }

  remove(ids: readonly string[]): void {
    const gone = new Set(ids);
    this.doc.update((draft) => {
      draft.sessions = draft.sessions.filter((entry) => !gone.has(entry.id));
    });
  }

  flush(): Promise<void> {
    return this.doc.flush();
  }
}
