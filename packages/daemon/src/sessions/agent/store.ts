// The persistent records of agent sessions (ARCHITECTURE §7.6 "The record"; DESIGN §2.2): what a later process start
// needs, never on the wire. One state document (`agent-sessions`); the role prompt, which is large and never changes,
// is a file next to the session's transcript (`role.md`, written once, sent byte for byte at every start).
//
// An agent session survives a daemon restart as an idle session (AD-10): a record that was not `ended` is loaded as
// idle (parked), whatever it was doing.
import { z } from 'zod';
import {
  AGENT_PURPOSES,
  PERMISSION_MODES,
  SESSION_END_REASONS,
  SMURG_TAG_PATTERN,
  displayNameSchema,
  epochMsSchema,
  itemIdSchema,
  messageOriginSchema,
  opaqueIdSchema,
  rememberedRuleSchema,
  rootRefSchema,
  shortTextSchema,
  smurgPurposeSchema,
  userIdSchema,
  userRefSchema,
} from '@smurg/protocol';
import type { PersistentDocument, StateStore } from '../../core/interfaces.ts';
import { declareDocument } from '../../core/state-store.ts';

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
  mode: z.enum(PERMISSION_MODES),
  /** Who loosened the mode from its default (the line `conversation.mode.reset` names them). */
  modeChangedBy: z.strictObject({ userId: userIdSchema, displayName: displayNameSchema }).optional(),
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
/** agent-sessions.json (no `version` key; new in 0.5.0). Declared by the sessions module. */
export const agentSessionsDocument = declareDocument({ name: AGENT_SESSIONS_DOCUMENT, schema: documentSchema, init: (): AgentDocument => ({ sessions: [] }) });

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
