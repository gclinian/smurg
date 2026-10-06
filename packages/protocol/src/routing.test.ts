// Who decides, who reviews, who is asked: the table of ARCHITECTURE §3 "Who decides" over roles × who is responsible ×
// escalated. The conversation, topics and inbox modules use exactly these functions.
import { describe, expect, it } from 'vitest';
import type { Role } from './roles.ts';
import {
  agentAccessMembers,
  deciderOf,
  hostOf,
  mayAllowForTopic,
  mayAnswerInOwnWords,
  mayBeResponsible,
  mayDecidePermission,
  mayEndSession,
  mayReview,
  maySubmit,
  permissionRecipients,
  questionRecipients,
  reportRecipients,
  reviewersOf,
  suggestionRecipients,
  voteRecipients,
  type RoutingMembers,
} from './routing.ts';

const IAN = 'dev:ian'; // host
const MEI = 'dev:mei'; // agent access
const AMY = 'dev:amy'; // editor
const LEO = 'dev:leo'; // viewer
const GONE = 'dev:gone'; // kicked: not in the list
const MEMBERS: RoutingMembers = [
  { userId: IAN, role: 'host' },
  { userId: MEI, role: 'agent' },
  { userId: AMY, role: 'editor' },
  { userId: LEO, role: 'viewer' },
];
const member = (userId: string): { userId: string; role: Role } => MEMBERS.find((m) => m.userId === userId) as { userId: string; role: Role };

describe('members', () => {
  it('the host and the members with agent access', () => {
    expect(hostOf(MEMBERS)).toBe(IAN);
    expect(hostOf([])).toBeNull();
    expect(agentAccessMembers(MEMBERS)).toEqual([IAN, MEI]);
  });

  it('anyone but a viewer can be responsible; it adds no capability', () => {
    expect((['host', 'agent', 'editor', 'viewer'] as const).map((role) => mayBeResponsible(role))).toEqual([true, true, true, false]);
    expect(mayBeResponsible(null)).toBe(false);
    expect((['host', 'agent', 'editor', 'viewer'] as const).map((role) => mayAnswerInOwnWords(role))).toEqual([true, true, false, false]);
    expect((['host', 'agent', 'editor', 'viewer'] as const).map((role) => mayAllowForTopic(role))).toEqual([true, true, false, false]);
  });
});

describe('deciderOf', () => {
  it.each([
    // [responsible, fallback decider, expected, why]
    [MEI, AMY, MEI, 'the responsible person'],
    [AMY, MEI, AMY, 'an Editor who is responsible decides (among the options)'],
    [null, MEI, MEI, 'nobody assigned: the member who opened it or pressed Start'],
    [null, AMY, AMY, 'a stored fallback who holds discuss'],
    [null, null, IAN, 'a cleared fallback: the host'],
    [LEO, MEI, MEI, 'a responsible person who became a Viewer does not count'],
    [GONE, MEI, MEI, 'a responsible person who was removed does not count'],
    [GONE, GONE, IAN, 'both gone: the host'],
    [null, LEO, IAN, 'a fallback who became a Viewer does not count'],
    [IAN, MEI, IAN, 'the host as the responsible person'],
  ] as const)('responsible %s, fallback %s → %s (%s)', (responsible, fallbackDecider, expected, _why) => {
    expect(deciderOf({ responsible, fallbackDecider }, MEMBERS)).toBe(expected);
  });
});

describe('questions', () => {
  it('who has it in their inbox as a question, before and after escalation', () => {
    const session = { responsible: AMY, fallbackDecider: MEI };
    expect(questionRecipients({ escalated: false }, session, MEMBERS)).toEqual([AMY]);
    expect(questionRecipients({ escalated: true }, session, MEMBERS).sort()).toEqual([AMY, IAN, MEI].sort());
    expect(questionRecipients({ escalated: true }, { responsible: MEI, fallbackDecider: null }, MEMBERS).sort()).toEqual([IAN, MEI].sort());
  });

  it('an open vote is in the inbox of everyone who has not voted, only when nobody is assigned', () => {
    const nobody = { responsible: null, fallbackDecider: MEI };
    expect(voteRecipients({ voted: [] }, nobody, MEMBERS)).toEqual([IAN, AMY]); // not the decider (Mei), not the Viewer
    expect(voteRecipients({ voted: new Set([AMY]) }, nobody, MEMBERS)).toEqual([IAN]);
    expect(voteRecipients({ voted: [IAN, AMY] }, nobody, MEMBERS)).toEqual([]);
    expect(voteRecipients({ voted: [] }, { responsible: AMY, fallbackDecider: MEI }, MEMBERS)).toEqual([]);
    // A responsible person who no longer counts is "nobody assigned".
    expect(voteRecipients({ voted: [] }, { responsible: LEO, fallbackDecider: null }, MEMBERS)).toEqual([MEI, AMY]);
  });

  it.each([
    // [member, decider, escalated, may submit]
    [MEI, MEI, false, true],
    [AMY, AMY, false, true], // an Editor who decides
    [IAN, MEI, false, true], // the host at any time
    [MEI, AMY, false, false],
    [MEI, AMY, true, true], // "Submit for Amy"
    [AMY, MEI, true, false], // escalation reaches members with agent access only
    [LEO, LEO, true, false], // a viewer never submits
    [AMY, null, false, false],
  ] as const)('%s submits a question decided by %s (escalated: %s): %s', (who, decider, escalated, expected) => {
    expect(maySubmit(member(who), { decider, escalated })).toBe(expected);
  });
});

describe('permission requests and suggestions', () => {
  it.each([
    // [hostOnly, responsible, escalated, recipients]
    [true, MEI, false, [IAN]],
    [true, null, true, [IAN]],
    [false, MEI, false, [MEI]],
    [false, MEI, true, [IAN, MEI]],
    [false, AMY, false, [IAN, MEI]], // the responsible person cannot allow
    [false, null, false, [IAN, MEI]], // nobody assigned
    [false, GONE, false, [IAN, MEI]],
    [false, IAN, false, [IAN]],
  ] as const)('host-only %s, responsible %s, escalated %s → %j', (hostOnly, responsible, escalated, expected) => {
    expect(permissionRecipients({ hostOnly, escalated }, { responsible }, MEMBERS)).toEqual(expected);
  });

  it('a suggestion is routed like a permission request that is not host-only', () => {
    expect(suggestionRecipients({ responsible: MEI }, MEMBERS)).toEqual([MEI]);
    expect(suggestionRecipients({ responsible: AMY }, MEMBERS)).toEqual([IAN, MEI]);
    expect(suggestionRecipients({ responsible: null }, MEMBERS)).toEqual([IAN, MEI]);
  });

  it('who may answer: members with agent access; a host-only request the host', () => {
    expect([IAN, MEI, AMY, LEO].map((who) => mayDecidePermission(member(who), { hostOnly: false }))).toEqual([true, true, false, false]);
    expect([IAN, MEI, AMY, LEO].map((who) => mayDecidePermission(member(who), { hostOnly: true }))).toEqual([true, false, false, false]);
  });
});

describe('result reports', () => {
  it('the responsible person reviews; nobody assigned: anyone but a viewer, once, for all', () => {
    expect(reviewersOf({ responsible: AMY }, MEMBERS)).toEqual([AMY]);
    expect(reviewersOf({ responsible: null }, MEMBERS)).toEqual([IAN, MEI, AMY]);
    expect(reviewersOf({ responsible: LEO }, MEMBERS)).toEqual([IAN, MEI, AMY]);
    expect(reviewersOf({ responsible: GONE }, MEMBERS)).toEqual([IAN, MEI, AMY]);
  });

  it('a report that waits too long also reaches the host and members with agent access', () => {
    expect(reportRecipients({ escalated: false }, { responsible: AMY }, MEMBERS)).toEqual([AMY]);
    expect(reportRecipients({ escalated: true }, { responsible: AMY }, MEMBERS).sort()).toEqual([AMY, IAN, MEI].sort());
  });

  it.each([
    // [member, reviewers, escalated, may review]
    [AMY, [AMY], false, true],
    [MEI, [AMY], false, false],
    [IAN, [AMY], false, false], // being the host adds nothing here before escalation
    [MEI, [AMY], true, true], // "Review instead of Amy"
    [IAN, [AMY], true, true],
    [LEO, [LEO], true, false],
    [AMY, [IAN, MEI, AMY], false, true],
  ] as const)('%s reviews a report of %j (escalated: %s): %s', (who, reviewers, escalated, expected) => {
    expect(mayReview(member(who), { reviewers, escalated })).toBe(expected);
  });
});

describe('ending a session', () => {
  it('a terminal: the member who opened it', () => {
    expect(mayEndSession(member(MEI), { kind: 'terminal', openedBy: MEI })).toBe(true);
    expect(mayEndSession(member(IAN), { kind: 'terminal', openedBy: MEI })).toBe(false); // the host terminates in the console
  });

  it('an agent session: the host, or a member with agent access who opened it or is responsible for it', () => {
    const item = { kind: 'agent', purpose: 'item', openedBy: MEI, responsible: AMY } as const;
    expect(mayEndSession(member(IAN), item)).toBe(true);
    expect(mayEndSession(member(MEI), item)).toBe(true);
    expect(mayEndSession(member(AMY), item)).toBe(false); // responsible, but an Editor
    expect(mayEndSession(member(MEI), { ...item, openedBy: IAN, responsible: MEI })).toBe(true);
    expect(mayEndSession(member(MEI), { ...item, openedBy: IAN, responsible: null })).toBe(false);
    expect(mayEndSession(member(LEO), { ...item, openedBy: LEO })).toBe(false);
  });

  it("a topic's discussion: nobody", () => {
    for (const who of [IAN, MEI, AMY, LEO]) expect(mayEndSession(member(who), { kind: 'agent', purpose: 'discussion', openedBy: who, responsible: who })).toBe(false);
  });
});
