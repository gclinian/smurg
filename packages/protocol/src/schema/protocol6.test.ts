// What protocol 6 added (smurg 0.7.0, DESIGN 0.7.0 D2-D5, D9, D13, Appendix A): the workspace setting `merging`, what
// a work item says about its merge (`merging`, `autoMerge`, `merged`, `leftOut`, `undone`, `waiting`), the phase
// `ready`, a topic's `checked` and its counts of items left out and undone, a report's failed check, the Start
// dialog's merge policy, the inbox kinds `decision` and `ready`, the update's notice `auto-merge`. Every message has
// samples in message-samples.fixture.ts (run by registry.test.ts); this file holds the rules a sample alone does not
// say, and states, shape by shape, what a peer of protocol 5 meets (R-ENG E10): the shapes that gained a required key
// refuse protocol 5's; the two that only gained optional keys and enum values accept protocol 5's, so for those the
// meaningful direction is the other one: protocol 5's own strict schemas (the code of tag v0.6.0, the last published
// smurg of protocol 5) refuse protocol 6's.
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../constants.ts';
import { decisionRecipients, permissionRecipients } from '../routing.ts';
import { SMURG_PURPOSES } from './conversation.ts';
import { AUDIT_ACTIONS, HOST_NOTICES, MERGE_POLICIES, hostSettingsPatchSchema, mergeRequestSchema, publicSettingsSchema } from './entities.ts';
import { welcomeSchema } from './handshake.ts';
import { ATTENTION_SUBJECTS, INBOX_KINDS, INBOX_KIND_FIELDS, columnTargetSchema, inboxItemSchema, inboxKindWaits } from './inbox.ts';
import {
  autoMergeNoticeItem,
  autoPlan,
  conflictItem,
  decisionItem,
  detachedPreflight,
  directPreflight,
  draftRequest,
  failedReport,
  heldItem,
  hostHeldItem,
  inboxItem,
  mergedAutoItem,
  preflight,
  publicSettings,
  readyItem,
  readyTopic,
  smurgHistoryPreflight,
  topic,
  waitingItem,
  workItem,
} from './message-samples.fixture.ts';
import {
  AUTO_MERGE_REASONS,
  AUTO_MERGE_STATES,
  HOST_HOLDS,
  RELEASABLE_HOLDS,
  SELF_CLEARING_HOLDS,
  TOPIC_PHASES,
  autoMergeInfoSchema,
  planInfoSchema,
  reportChecksSchema,
  reportInfoSchema,
  startPreflightSchema,
  topicSchema,
  workItemSchema,
} from './topics.ts';

const run = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const RELEASE_GATE = process.env['SMURG_RELEASE_GATE'] === '1';
/**
 * The last published smurg of protocol 5. It does not move after a release: this file says what protocol 6 changed
 * against protocol 5 (the tests that follow the newest published tag are wire, other-version and ctl-other-version).
 */
const PROTOCOL_5_TAG = 'v0.6.0';

const welcome = {
  channelId: 'ch_1',
  resumed: false,
  member: { userId: 'dev:ian', displayName: 'Ian', role: 'host', color: '#ff8800', online: true, joinedAt: 1 },
  workspace: { id: 'AbCdEfGh_-012345', name: 'Smurg', hostUserId: 'dev:ian', hostName: 'Ian', platform: 'darwin', isGitRepo: false },
  settings: publicSettings,
  serverTime: 1,
};

/** `value` without `key` (a protocol-5 shape: the key did not exist). */
function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

describe('protocol 6', () => {
  it('is the version a hello carries', () => {
    expect(PROTOCOL_VERSION).toBe(6);
  });
});

describe('what a peer of protocol 5 meets, shape by shape (D2)', () => {
  it('a protocol-5 Welcome (its settings have no `merging`) is refused: every member learns how work items merge', () => {
    expect(welcomeSchema.safeParse(welcome).success).toBe(true);
    const protocol5 = without(publicSettings, 'merging');
    expect(publicSettingsSchema.safeParse(protocol5).success).toBe(false);
    expect(welcomeSchema.safeParse({ ...welcome, settings: protocol5 }).success).toBe(false);
  });

  it('a protocol-5 Topic (its plan has no `leftOut` and no `undone`) is refused', () => {
    expect(topicSchema.safeParse(topic).success).toBe(true);
    expect(topicSchema.safeParse({ ...topic, plan: without(without(topic.plan, 'leftOut'), 'undone') }).success).toBe(false);
    expect(topicSchema.safeParse({ ...topic, plan: without(topic.plan, 'leftOut') }).success).toBe(false);
  });

  it('a protocol-5 Start preflight (no `merging`) is refused, and so is a plan whose waiting list has no `decisions`', () => {
    expect(startPreflightSchema.safeParse(preflight).success).toBe(true);
    expect(startPreflightSchema.safeParse(without(preflight, 'merging')).success).toBe(false);
    expect(planInfoSchema.safeParse(autoPlan).success).toBe(true);
    expect(planInfoSchema.safeParse({ ...autoPlan, waitingFor: autoPlan.waitingFor.map((entry) => without(entry, 'decisions')) }).success).toBe(false);
  });

  it('a protocol-5 WorkItem and InboxItem are ACCEPTED: every addition to them is optional, and the new inbox kinds only widen an enum', () => {
    for (const item of [workItem, waitingItem]) expect(workItemSchema.safeParse(item).success).toBe(true);
    expect(inboxItemSchema.safeParse(inboxItem).success).toBe(true);
  });

  it(`so for those two the other direction: the strict schemas of ${PROTOCOL_5_TAG} (the code of the tag) refuse a protocol-6 WorkItem with \`autoMerge\` and an InboxItem of kind \`decision\``, async (context) => {
    const tree = await protocolOfTheTag();
    if ('missing' in tree) {
      if (RELEASE_GATE) throw new Error(tree.missing);
      console.warn(`SKIPPED: ${tree.missing}`);
      context.skip();
      return;
    }
    const tagTopics = (await import(join(tree.src, 'schema', 'topics.ts'))) as { workItemSchema: typeof workItemSchema };
    const tagInbox = (await import(join(tree.src, 'schema', 'inbox.ts'))) as { inboxItemSchema: typeof inboxItemSchema };
    const { PROTOCOL_VERSION: protocolOfTag } = (await import(join(tree.src, 'constants.ts'))) as { PROTOCOL_VERSION: number };
    expect(protocolOfTag).toBe(5);
    // What both have: the tag reads it.
    expect(tagTopics.workItemSchema.safeParse(workItem).success).toBe(true);
    expect(tagInbox.inboxItemSchema.safeParse(inboxItem).success).toBe(true);
    // What protocol 6 added: the tag refuses it.
    const item = tagTopics.workItemSchema.safeParse(heldItem);
    expect(item.success).toBe(false);
    expect(item.error?.issues.map((issue) => issue.code)).toContain('unrecognized_keys');
    const decision = tagInbox.inboxItemSchema.safeParse(decisionItem);
    expect(decision.success).toBe(false);
    expect(tagInbox.inboxItemSchema.safeParse(readyItem).success).toBe(false);
    expect(tagInbox.inboxItemSchema.safeParse(autoMergeNoticeItem).success).toBe(false);
  });
});

describe('the consent: the workspace setting and the Start (D3)', () => {
  it('two policies; only the host sets the setting (it is a host setting, patched like every other)', () => {
    expect([...MERGE_POLICIES]).toEqual(['auto', 'host']);
    expect(hostSettingsPatchSchema.safeParse({ merging: 'host' }).success).toBe(true);
    expect(hostSettingsPatchSchema.safeParse({ merging: 'smurg' }).success).toBe(false);
  });

  it('the Start dialog says how the items merge unless they run directly in the folder; a detached HEAD and a workspace whose host merges propose only the host', () => {
    for (const valid of [preflight, smurgHistoryPreflight, directPreflight, detachedPreflight]) expect(startPreflightSchema.safeParse(valid).success).toBe(true);
    expect(startPreflightSchema.safeParse({ ...preflight, merging: null }).success).toBe(false);
    expect(startPreflightSchema.safeParse({ ...directPreflight, merging: preflight.merging }).success).toBe(false);
    expect(startPreflightSchema.safeParse({ ...preflight, merging: { workspace: 'auto', proposed: 'auto', detached: true } }).success).toBe(false);
    expect(startPreflightSchema.safeParse({ ...smurgHistoryPreflight, merging: { workspace: 'auto', proposed: 'host', detached: true } }).success).toBe(false);
    expect(startPreflightSchema.safeParse({ ...preflight, merging: { workspace: 'host', proposed: 'auto', detached: false } }).success).toBe(false);
    expect(startPreflightSchema.safeParse({ ...preflight, merging: { workspace: 'host', proposed: 'host', detached: false } }).success).toBe(true);
  });
});

describe('a report says what failed (D5)', () => {
  it('`failed` counts are optional (a report of 0.6.0 had none); a failed check did not pass and says what happened', () => {
    expect(reportChecksSchema.safeParse({ passed: 1, notVerified: 0 }).success).toBe(true);
    expect(reportChecksSchema.safeParse({ passed: 1, notVerified: 0, failed: 2 }).success).toBe(true);
    expect(reportInfoSchema.safeParse(failedReport).success).toBe(true);
    const verified = (check: Record<string, unknown>) => ({ ...failedReport, sections: { ...failedReport.sections, verified: [check] } });
    expect(reportInfoSchema.safeParse(verified({ text: 'x', passed: false, failed: true, note: 'it broke' })).success).toBe(true);
    expect(reportInfoSchema.safeParse(verified({ text: 'x', passed: true, failed: true, note: 'it broke' })).success).toBe(false);
    expect(reportInfoSchema.safeParse(verified({ text: 'x', passed: false, failed: true })).success).toBe(false);
    expect(reportInfoSchema.safeParse(verified({ text: 'x', passed: false, failed: false, note: 'y' })).success).toBe(false);
  });
});

describe('what a work item says about its merge (D6-D9)', () => {
  it('the reasons, in three states; the host\'s holds, those that clear by themselves and those "Merge it as it is" settles are reasons', () => {
    expect([...AUTO_MERGE_STATES]).toEqual(['waiting', 'resolving', 'held']);
    expect(new Set(AUTO_MERGE_REASONS).size).toBe(AUTO_MERGE_REASONS.length);
    for (const list of [HOST_HOLDS, SELF_CLEARING_HOLDS, RELEASABLE_HOLDS]) for (const reason of list) expect(AUTO_MERGE_REASONS, reason).toContain(reason);
    // Every hold that clears by itself is the host's main workspace in the way: the host's.
    for (const reason of SELF_CLEARING_HOLDS) expect(HOST_HOLDS, reason).toContain(reason);
    // What "Merge it as it is" settles is the carers', never the host's alone.
    for (const reason of RELEASABLE_HOLDS) expect(HOST_HOLDS, reason).not.toContain(reason);
  });

  it('a reason is one of its state\'s; a hold is the host\'s exactly when it is one of HOST_HOLDS, and only a hold that is not escalates', () => {
    const base = { since: 1, tries: 0, escalated: false };
    expect(autoMergeInfoSchema.safeParse({ ...base, state: 'waiting', reason: 'typing', hostOnly: false, paths: ['a.txt'] }).success).toBe(true);
    expect(autoMergeInfoSchema.safeParse({ ...base, state: 'waiting', reason: 'partial', hostOnly: false }).success).toBe(false);
    expect(autoMergeInfoSchema.safeParse({ ...base, state: 'resolving', reason: 'markers', hostOnly: false }).success).toBe(true);
    expect(autoMergeInfoSchema.safeParse({ ...base, state: 'held', reason: 'markers', hostOnly: false }).success).toBe(false);
    for (const reason of ['conflict', 'stale-report', 'asked', 'git-busy'] as const) {
      expect(autoMergeInfoSchema.safeParse({ ...base, state: 'held', reason, hostOnly: (HOST_HOLDS as readonly string[]).includes(reason) }).success, reason).toBe(true);
    }
    expect(autoMergeInfoSchema.safeParse({ ...base, state: 'held', reason: 'git-busy', hostOnly: false }).success).toBe(false);
    expect(autoMergeInfoSchema.safeParse({ ...base, state: 'waiting', reason: 'git-busy', hostOnly: true }).success).toBe(false);
    expect(autoMergeInfoSchema.safeParse({ ...base, state: 'held', reason: 'by-hand', hostOnly: true, escalated: true }).success).toBe(false);
    expect(autoMergeInfoSchema.safeParse({ ...base, state: 'held', reason: 'partial', hostOnly: false, escalated: true }).success).toBe(true);
    expect(autoMergeInfoSchema.safeParse({ ...base, state: 'waiting', reason: 'behind', hostOnly: false, escalated: true }).success).toBe(false);
  });

  it('who changed the other side goes with a conflict, the branches with `branch`, who wrote with `asked`', () => {
    for (const item of [heldItem, hostHeldItem, conflictItem, mergedAutoItem]) expect(workItemSchema.safeParse(item).success).toBe(true);
    const held = { since: 1, tries: 0, escalated: false, hostOnly: false };
    const people = [{ path: 'config.txt', by: [{ userId: 'dev:bo', displayName: 'Bo' }], outside: false }];
    expect(autoMergeInfoSchema.safeParse({ ...held, state: 'held', reason: 'conflict', people }).success).toBe(true);
    expect(autoMergeInfoSchema.safeParse({ ...held, state: 'held', reason: 'partial', people }).success).toBe(false);
    expect(autoMergeInfoSchema.safeParse({ ...held, state: 'held', reason: 'conflict', people: [{ ...people[0], by: Array.from({ length: 6 }, (_, i) => ({ userId: `dev:p${i}`, displayName: 'P' })) }] }).success).toBe(false);
    expect(autoMergeInfoSchema.safeParse({ ...held, hostOnly: true, state: 'held', reason: 'branch', branch: { expected: 'main', current: 'experiment' } }).success).toBe(true);
    expect(autoMergeInfoSchema.safeParse({ ...held, hostOnly: true, state: 'held', reason: 'staged', branch: { expected: 'main', current: 'experiment' } }).success).toBe(false);
    expect(autoMergeInfoSchema.safeParse({ ...held, state: 'held', reason: 'asked', asked: { userId: 'dev:mei', displayName: 'Mei' } }).success).toBe(true);
    expect(autoMergeInfoSchema.safeParse({ ...held, state: 'held', reason: 'stopped', asked: { userId: 'dev:mei', displayName: 'Mei' } }).success).toBe(false);
  });

  // 0.7.0 last check (W/verify/last F1): "Merge it as it is" and "Accept as it is" are refused while a message no turn
  // has taken waits in the item's session and nothing delivers it by itself; the foot must know to offer Continue instead.
  it('`undelivered` goes with a hold: a message waits in the item\'s session, and only Continue delivers it', () => {
    const held = { since: 1, tries: 0, escalated: false, hostOnly: false };
    expect(autoMergeInfoSchema.safeParse({ ...held, state: 'held', reason: 'stopped', undelivered: true }).success).toBe(true);
    expect(autoMergeInfoSchema.safeParse({ ...held, state: 'held', reason: 'partial', undelivered: true }).success).toBe(true);
    expect(autoMergeInfoSchema.safeParse({ ...held, state: 'waiting', reason: 'busy', undelivered: true }).success).toBe(false);
    expect(autoMergeInfoSchema.safeParse({ ...held, state: 'held', reason: 'stopped', undelivered: false }).success).toBe(false);
    expect(workItemSchema.safeParse({ ...heldItem, autoMerge: { ...heldItem.autoMerge, reason: 'stopped', undelivered: true } }).success).toBe(true);
  });

  // 0.7.0 fix8 (W/verify/last7/hold, E3): Continue and the resolve of a conflict are refused once the item's session has
  // ended; the foot must know to offer the worktree's "Request merge" for what a merged item's worktree holds instead.
  it('`sessionEnded` goes with a hold: the item\'s session has ended, and nothing continues it', () => {
    const held = { since: 1, tries: 0, escalated: false, hostOnly: false };
    expect(autoMergeInfoSchema.safeParse({ ...held, state: 'held', reason: 'edited', sessionEnded: true }).success).toBe(true);
    expect(autoMergeInfoSchema.safeParse({ ...held, state: 'held', reason: 'stopped', sessionEnded: true }).success).toBe(true);
    expect(autoMergeInfoSchema.safeParse({ ...held, state: 'waiting', reason: 'busy', sessionEnded: true }).success).toBe(false);
    expect(autoMergeInfoSchema.safeParse({ ...held, state: 'held', reason: 'edited', sessionEnded: false }).success).toBe(false);
    expect(workItemSchema.safeParse({ ...heldItem, autoMerge: { ...heldItem.autoMerge, reason: 'edited', sessionEnded: true } }).success).toBe(true);
  });

  it('merged by smurg or by a person; a session waits for a question or a permission request', () => {
    expect(workItemSchema.safeParse({ ...mergedAutoItem, merged: { at: 1, by: { userId: 'dev:ian', displayName: 'Ian' } } }).success).toBe(true);
    expect(workItemSchema.safeParse({ ...mergedAutoItem, merged: { at: 1, by: 'host' } }).success).toBe(false);
    expect(workItemSchema.safeParse({ ...heldItem, waiting: 'permission' }).success).toBe(true);
    expect(workItemSchema.safeParse({ ...heldItem, waiting: 'suggestion' }).success).toBe(false);
  });

  it('a decision is routed like a permission request (routing.ts)', () => {
    const members = [
      { userId: 'dev:ian', role: 'host' },
      { userId: 'dev:mei', role: 'agent' },
    ] as const;
    for (const hostOnly of [true, false]) for (const escalated of [true, false]) {
      expect(decisionRecipients({ hostOnly, escalated }, { responsible: 'dev:mei' }, members)).toEqual(permissionRecipients({ hostOnly, escalated }, { responsible: 'dev:mei' }, members));
    }
  });
});

describe('the end of a topic (D13)', () => {
  it('`ready` sits between executing and complete; a ready topic counts its items left out and undone, a checked one says who checked it', () => {
    expect([...TOPIC_PHASES]).toEqual(['discussing', 'spec', 'plan', 'executing', 'ready', 'complete']);
    expect(topicSchema.safeParse(readyTopic).success).toBe(true);
    expect(topicSchema.safeParse({ ...readyTopic, phase: 'complete', checked: { by: { userId: 'dev:amy', displayName: 'Amy' }, at: 1 } }).success).toBe(true);
    expect(topicSchema.safeParse({ ...readyTopic, checked: { at: 1 } }).success).toBe(false);
  });

  it('the inbox: a decision waits (amber) and names its reason; a topic ready to check waits for nobody, opens the Result column and tallies its items', () => {
    expect(INBOX_KINDS).toContain('decision');
    expect(INBOX_KINDS).toContain('ready');
    expect(inboxKindWaits('decision')).toBe(true);
    expect(inboxKindWaits('ready')).toBe(false);
    expect(INBOX_KIND_FIELDS.decision.required).toEqual(['topicId', 'itemId', 'item', 'reason']);
    expect(INBOX_KIND_FIELDS.ready).toEqual({ required: ['topicId', 'tally', 'checks'], optional: [] });
    for (const kind of ['question', 'permission', 'attention'] as const) expect(INBOX_KIND_FIELDS[kind].optional, kind).toContain('unblocks');
    expect(inboxItemSchema.safeParse(decisionItem).success).toBe(true);
    expect(inboxItemSchema.safeParse(readyItem).success).toBe(true);
    expect(inboxItemSchema.safeParse({ ...decisionItem, waiting: false }).success).toBe(false);
    expect(inboxItemSchema.safeParse({ ...readyItem, waiting: true }).success).toBe(false);
    expect(columnTargetSchema.safeParse({ kind: 'result', topicId: 'tp_1' }).success).toBe(true);
    expect(columnTargetSchema.safeParse({ kind: 'result' }).success).toBe(false);
  });

  // 0.7.0 verify (the lead's decision R7): a suggestion to a work item's agent is a decision; one elsewhere is not.
  it('the inbox: a suggestion to a work item\'s agent (its row names the item) waits, and escalates like a permission request; one in another session does not wait', () => {
    expect(inboxKindWaits('suggestion', undefined, 'cart-api')).toBe(true);
    expect(inboxKindWaits('suggestion')).toBe(false);
    const suggestion = { key: 'suggestion:sess_1.dev-amy', kind: 'suggestion', at: 1, unread: true, waiting: false, target: { kind: 'session', sessionId: 'sess_1' }, excerpt: 'Round it', sessionId: 'sess_1', anchor: { cardId: 'sg_1' }, from: { kind: 'user', userId: 'dev:amy', displayName: 'Amy' }, count: 1 };
    const onItem = { ...suggestion, topicId: 'tp_1', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, waiting: true };
    expect(inboxItemSchema.safeParse(suggestion).success).toBe(true);
    expect(inboxItemSchema.safeParse(onItem).success).toBe(true);
    expect(inboxItemSchema.safeParse({ ...onItem, waiting: false }).success).toBe(false);
    expect(inboxItemSchema.safeParse({ ...suggestion, waiting: true }).success).toBe(false);
    expect(inboxItemSchema.safeParse({ ...onItem, escalated: true, waitsFor: { userId: 'dev:mei', displayName: 'Mei' }, waitsForOffline: false }).success).toBe(true);
  });
});

describe('the update\'s notice, the audit, smurg\'s messages, merge requests', () => {
  it('`auto-merge` is the host\'s attention item of the 0.7.0 update: it stops no work and opens the console\'s settings', () => {
    expect([...HOST_NOTICES]).toEqual(['agents-auto', 'auto-merge']);
    expect(ATTENTION_SUBJECTS).toContain('auto-merge');
    expect(inboxKindWaits('attention', 'auto-merge')).toBe(false);
    expect(inboxItemSchema.safeParse(autoMergeNoticeItem).success).toBe(true);
  });

  it('the audit names automatic merges, holds, undo, the check, Pause and the carers\' and the host\'s new actions; smurg tells the agent two new things', () => {
    for (const action of ['worktree.merge.auto', 'worktree.merge.held', 'worktree.merge.undo', 'topic.check', 'plan.pause', 'plan.item.leaveOut', 'plan.item.accept', 'plan.item.release', 'plan.item.removePaths', 'plan.item.autoContinue', 'plan.merging.host'] as const) {
      expect(AUDIT_ACTIONS, action).toContain(action);
    }
    expect(SMURG_PURPOSES).toContain('remove-paths');
    expect(SMURG_PURPOSES).toContain('verify-again');
  });

  it('a merge request says that smurg merged it, and that the host undid it', () => {
    expect(mergeRequestSchema.safeParse({ ...draftRequest, status: 'merged', auto: true }).success).toBe(true);
    expect(mergeRequestSchema.safeParse({ ...draftRequest, status: 'merged', auto: false }).success).toBe(false);
    expect(mergeRequestSchema.safeParse({ ...draftRequest, status: 'merged', undone: { commit: 'a'.repeat(40), at: 1, by: { userId: 'dev:ian', displayName: 'Ian' } } }).success).toBe(true);
  });
});

// ── the code of the tag ─────────────────────────────────────────────────────────────────────────────────────────────

let scratch: string | null = null;
afterAll(async () => {
  if (scratch !== null) await rm(scratch, { recursive: true, force: true });
});

/**
 * The protocol package of PROTOCOL_5_TAG in a scratch folder: `git archive`, as packages/cli/test/ctl-other-version.test.ts
 * gets the newest tag's, or `$SMURG_PUBLISHED_TREES/<tag>/`; its dependencies are this checkout's. Or why it cannot be
 * had (a shallow clone has no tags).
 */
async function protocolOfTheTag(): Promise<{ readonly src: string } | { readonly missing: string }> {
  scratch ??= await mkdtemp(join(tmpdir(), 'smurg-protocol6-'));
  const into = scratch;
  const given = process.env['SMURG_PUBLISHED_TREES'];
  try {
    if (given !== undefined && given !== '') {
      await cp(join(given, PROTOCOL_5_TAG, 'packages', 'protocol'), join(into, 'packages', 'protocol'), { recursive: true, filter: (source) => !source.split('/').includes('node_modules') });
      await cp(join(given, PROTOCOL_5_TAG, 'tsconfig.base.json'), join(into, 'tsconfig.base.json')).catch(() => cp(join(REPO, 'tsconfig.base.json'), join(into, 'tsconfig.base.json')));
    } else {
      const archive = join(into, 'tag.tar');
      await run('git', ['-C', REPO, 'archive', '--format=tar', '-o', archive, PROTOCOL_5_TAG, 'packages/protocol', 'tsconfig.base.json'], { maxBuffer: 64 * 1024 * 1024 });
      await run('tar', ['-xf', archive, '-C', into]);
    }
  } catch (err) {
    return { missing: `the protocol package of ${PROTOCOL_5_TAG} could not be had (no tag: a shallow checkout?): ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}` };
  }
  await symlink(join(REPO, 'packages', 'protocol', 'node_modules'), join(into, 'packages', 'protocol', 'node_modules'));
  const version = (JSON.parse(await readFile(join(into, 'packages', 'protocol', 'package.json'), 'utf8')) as { version: string }).version;
  if (`v${version}` !== PROTOCOL_5_TAG) return { missing: `the tree for ${PROTOCOL_5_TAG} says it is ${version}` };
  return { src: join(into, 'packages', 'protocol', 'src') };
}
