import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_EVENT_KINDS,
  INBOX_KINDS,
  agentSessionSchema,
  conversationEventSchema,
  inboxItemSchema,
  mergeRequestSchema,
  permissionRequestSchema,
  planInfoSchema,
  questionSchema,
  reportInfoSchema,
  reportSummarySchema,
  suggestionSchema,
  terminalSessionSchema,
  topicSchema,
  workItemSchema,
  worktreeInfoSchema,
} from '../schema/index.ts';
import {
  buildAgentSession,
  buildEvent,
  buildEvents,
  buildInboxItem,
  buildMergeRequest,
  buildPermission,
  buildPlan,
  buildQuestion,
  buildReport,
  buildReportSummary,
  buildSuggestion,
  buildTerminalSession,
  buildTopic,
  buildWorkItem,
  buildWorktree,
} from './builders.ts';

describe('the test builders (@smurg/protocol/testing): every default passes its wire schema', () => {
  it('entities', () => {
    const cases = [
      [agentSessionSchema, buildAgentSession()],
      [agentSessionSchema, buildAgentSession({ purpose: 'discussion', topicId: 'tp_1', modeFixed: true })],
      [agentSessionSchema, buildAgentSession({ purpose: 'item', topicId: 'tp_1', itemId: 'cart-api' })],
      [terminalSessionSchema, buildTerminalSession()],
      [questionSchema, buildQuestion()],
      [permissionRequestSchema, buildPermission()],
      [suggestionSchema, buildSuggestion()],
      [topicSchema, buildTopic()],
      [workItemSchema, buildWorkItem()],
      [planInfoSchema, buildPlan()],
      [reportSummarySchema, buildReportSummary()],
      [reportInfoSchema, buildReport()],
      [mergeRequestSchema, buildMergeRequest()],
      [mergeRequestSchema, buildMergeRequest({ status: 'draft', requestedBy: undefined })],
      [worktreeInfoSchema, buildWorktree()],
    ] as const;
    for (const [schema, value] of cases) {
      const parsed = schema.safeParse(value);
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    }
  });

  it('a topic session gets the fields that go with its topic and item unless the test gives them', () => {
    expect(buildAgentSession({ purpose: 'item', topicId: 'tp_1', itemId: 'cart-api' })).toMatchObject({ topicName: 'Checkout', item: { number: 1, title: 'Cart API' }, attempt: 1 });
    expect(buildAgentSession({ purpose: 'item', topicId: 'tp_1', itemId: 'pay', topicName: 'Pay', item: { number: 4, title: 'Payment form' }, attempt: 2 })).toMatchObject({ topicName: 'Pay', item: { number: 4 }, attempt: 2 });
    expect(buildAgentSession()).not.toHaveProperty('topicName');
    // `undefined` removes a default: this one is refused on purpose.
    expect(agentSessionSchema.safeParse(buildAgentSession({ purpose: 'discussion', topicId: 'tp_1', topicName: undefined })).success).toBe(false);
  });

  it('one inbox item per kind', () => {
    for (const kind of INBOX_KINDS) {
      const parsed = inboxItemSchema.safeParse(buildInboxItem(kind));
      expect(parsed.success, `${kind}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
    }
    expect(inboxItemSchema.safeParse(buildInboxItem('attention', { key: 'attention:storage:workspace', subject: 'storage', waiting: false, topicId: undefined, itemId: undefined, item: undefined, sessionId: undefined, target: { kind: 'console', section: 'sessions' } })).success).toBe(true);
  });

  it('one conversation event per kind, and a run of events with consecutive seq', () => {
    for (const kind of CONVERSATION_EVENT_KINDS) {
      const parsed = conversationEventSchema.safeParse(buildEvent(kind));
      expect(parsed.success, `${kind}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
    }
    expect(buildEvent('text', { seq: 5, text: 'Done.' })).toMatchObject({ kind: 'text', seq: 5, text: 'Done.' });
    expect(buildEvents(['message', 'turn.started', 'text', 'turn.finished'], 7).map((event) => [event.seq, event.kind])).toEqual([[7, 'message'], [8, 'turn.started'], [9, 'text'], [10, 'turn.finished']]);
  });
});
