// What protocol 7 added (smurg 0.8.0, DESIGN 0.8.0 D2, D3, D8.2): the Welcome's `protocol`, Claude for the sticky
// notes as a session of purpose `notes`, and the messages `sticky.*`. Every message has samples in
// message-samples.fixture.ts (run by registry.test.ts); this file holds the rules a sample alone does not say, and
// states, shape by shape, what a peer of protocol 6 meets: the Welcome gained a required key, so this side refuses
// protocol 6's; a session only gained an enum value, so for it the meaningful direction is the other one: protocol
// 6's own strict schema (the code of tag v0.7.0, the last published smurg of protocol 6) refuses a session of purpose
// `notes`; protocol 6 has no message `sticky.*` (its registry knows none of the twelve types), no capability
// `feedback.give`, none of the four audit actions of feedback and no `sticky.build` (DESIGN 0.8.0 D4.1, D4.8, D5.2).
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../constants.ts';
import { CAPABILITIES, can, capabilitySchema, ROLES } from '../roles.ts';
import { confinedPurpose } from '../tools.ts';
import { AGENT_PURPOSES, AUDIT_ACTIONS, agentSessionSchema, auditActionSchema } from './entities.ts';
import { verdictSchema, welcomeSchema } from './handshake.ts';
import { agentSession, homeNote, notesSession, publicSettings } from './message-samples.fixture.ts';
import { MESSAGE_REGISTRY, MESSAGE_TYPES } from './registry.ts';
import { OUTSIDE_TOKEN_MAX_CHARS, feedbackSchema, isOutsideBotToken, isOutsideChannelId, noteBuildSchema, noteInfoSchema, stickyCursorsSchema } from './sticky.ts';

/** The message types protocol 7 added: the index, a new note, Claude for the sticky notes (S2), feedback (S5, D4.4), Build this (S7, D5). */
const STICKY_TYPES = [
  'sticky.list',
  'sticky.changed',
  'sticky.create',
  'sticky.assistant.start',
  'sticky.feedback.create',
  'sticky.feedback.withdraw',
  'sticky.feedback.accept',
  'sticky.feedback.reject',
  'sticky.feedback.list',
  'sticky.feedback.updated',
  'sticky.spec',
  'sticky.build',
] as const;
/** The audit actions protocol 7 added (D4.8): those of feedback, and "Build this" (S7, D5.2). */
const FEEDBACK_ACTIONS = ['sticky.feedback.create', 'sticky.feedback.accept', 'sticky.feedback.reject', 'sticky.feedback.withdraw'] as const;
const STICKY_ACTIONS = [...FEEDBACK_ACTIONS, 'sticky.build'] as const;

const run = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const RELEASE_GATE = process.env['SMURG_RELEASE_GATE'] === '1';
/**
 * The last published smurg of protocol 6. It does not move after a release: this file says what protocol 7 changed
 * against protocol 6 (the tests that follow the newest published tag are wire, other-version and ctl-other-version).
 */
const PROTOCOL_6_TAG = 'v0.7.0';

const welcome = {
  protocol: PROTOCOL_VERSION,
  channelId: 'ch_1',
  resumed: false,
  member: { userId: 'dev:ian', displayName: 'Ian', role: 'host', color: '#ff8800', online: true, joinedAt: 1 },
  workspace: { id: 'AbCdEfGh_-012345', name: 'Smurg', hostUserId: 'dev:ian', hostName: 'Ian', platform: 'darwin', isGitRepo: false },
  settings: publicSettings,
  serverTime: 1,
};

describe('protocol 7', () => {
  it('is the version a hello carries', () => {
    expect(PROTOCOL_VERSION).toBe(7);
  });
});

describe('what a peer of protocol 6 meets, shape by shape (D8.2)', () => {
  it('a protocol-6 Welcome (no `protocol`) is refused: the control socket has no hello, so this key makes a command and a daemon of different protocols refuse each other', () => {
    expect(welcomeSchema.safeParse(welcome).success).toBe(true);
    const { protocol: _gone, ...protocol6 } = welcome;
    expect(welcomeSchema.safeParse(protocol6).success).toBe(false);
    expect(verdictSchema.safeParse({ ok: true, welcome: protocol6 }).success).toBe(false);
  });

  it('a Welcome of another protocol number is refused, older or newer: the next raise refuses this one the same way', () => {
    for (const protocol of [PROTOCOL_VERSION - 1, PROTOCOL_VERSION + 1, 0, '7']) expect(welcomeSchema.safeParse({ ...welcome, protocol }).success, String(protocol)).toBe(false);
  });

  it('a protocol-6 session is ACCEPTED: the purpose `notes` only widens an enum', () => {
    expect(agentSessionSchema.safeParse(agentSession).success).toBe(true);
  });

  it(`so for a session the other direction: the strict schema of ${PROTOCOL_6_TAG} (the code of the tag) refuses a session of purpose \`notes\`, and refuses this smurg's Welcome`, async (context) => {
    const tree = await protocolOfTheTag();
    if ('missing' in tree) {
      if (RELEASE_GATE) throw new Error(tree.missing);
      console.warn(`SKIPPED: ${tree.missing}`);
      context.skip();
      return;
    }
    const tagEntities = (await import(join(tree.src, 'schema', 'entities.ts'))) as { agentSessionSchema: typeof agentSessionSchema };
    const tagHandshake = (await import(join(tree.src, 'schema', 'handshake.ts'))) as { welcomeSchema: typeof welcomeSchema };
    const { PROTOCOL_VERSION: protocolOfTag } = (await import(join(tree.src, 'constants.ts'))) as { PROTOCOL_VERSION: number };
    expect(protocolOfTag).toBe(6);
    // What both have: the tag reads it.
    expect(tagEntities.agentSessionSchema.safeParse(agentSession).success).toBe(true);
    const { protocol: _gone, ...protocol6 } = welcome;
    expect(tagHandshake.welcomeSchema.safeParse(protocol6).success).toBe(true);
    // What protocol 7 added: the tag refuses it.
    const notes = tagEntities.agentSessionSchema.safeParse(notesSession);
    expect(notes.success).toBe(false);
    expect(notes.error?.issues.map((issue) => issue.code)).toContain('invalid_value');
    const ours = tagHandshake.welcomeSchema.safeParse(welcome);
    expect(ours.success).toBe(false);
    expect(ours.error?.issues.map((issue) => issue.code)).toContain('unrecognized_keys');
    // The messages of the sticky notes are no type of protocol 6: a peer of the tag refuses each one as unknown.
    const tagRegistry = (await import(join(tree.src, 'schema', 'registry.ts'))) as { isMessageType: (type: string) => boolean };
    for (const type of STICKY_TYPES) expect(tagRegistry.isMessageType(type), type).toBe(false);
    // Feedback (D4.1, D4.8): the tag knows no capability `feedback.give` (its roles refuse it and grant it to no role)
    // and none of the four audit actions, so an audit line of this smurg's feedback is no line of the tag's; nor is
    // one of "Build this" (D5.2).
    const tagRoles = (await import(join(tree.src, 'roles.ts'))) as { capabilitySchema: typeof capabilitySchema; CAPABILITIES: readonly string[]; can: (role: string, capability: string) => boolean };
    expect(tagRoles.CAPABILITIES).not.toContain('feedback.give');
    expect(tagRoles.capabilitySchema.safeParse('feedback.give').success).toBe(false);
    for (const role of ROLES) expect(tagRoles.can(role, 'feedback.give'), role).toBe(false);
    const tagAudit = (await import(join(tree.src, 'schema', 'entities.ts'))) as { auditActionSchema: typeof auditActionSchema };
    for (const action of STICKY_ACTIONS) expect(tagAudit.auditActionSchema.safeParse(action).success, action).toBe(false);
    expect(tagAudit.auditActionSchema.safeParse('suggest.accept').success).toBe(true);
  });
});

describe('the messages of the sticky notes (D2.4, D2.5, D3.5, D4.4)', () => {
  it('are exactly twelve, under the one prefix `sticky`', () => {
    expect(MESSAGE_TYPES.filter((type) => type.startsWith('sticky.'))).toEqual([...STICKY_TYPES]);
  });

  it('every member who may read files reads the index and its changes; a new note is a write; Claude for the sticky notes is a session', () => {
    expect(MESSAGE_REGISTRY['sticky.list'].capability).toBe('file.read');
    expect(MESSAGE_REGISTRY['sticky.changed'].capability).toBe('file.read');
    expect(MESSAGE_REGISTRY['sticky.changed'].checks).toEqual(['recipients:all']);
    expect(MESSAGE_REGISTRY['sticky.create'].capability).toBe('file.write');
    expect(MESSAGE_REGISTRY['sticky.assistant.start'].capability).toBe('session.create');
    // Nothing of a note's content is on the wire but what "Build this" shows: no other type is sensitive (feedback is
    // like a suggestion: its text is redacted from the logs, not withheld from members). The text of `sticky.spec` is
    // the notes' text, read as the caller: its result is never logged, as file.read's is not (D5.1).
    for (const type of STICKY_TYPES) expect(MESSAGE_REGISTRY[type].sensitive || MESSAGE_REGISTRY[type].resultSensitive, type).toBe(type === 'sticky.spec');
    expect(MESSAGE_REGISTRY['sticky.spec'].resultSensitive).toBe(true);
    expect(MESSAGE_REGISTRY['sticky.spec'].sensitive).toBe(false);
  });

  it('"Build this" is for a member who may start sessions; the build names the text it confirms by its hash, and says nothing else (D5.1, D5.2)', () => {
    for (const type of ['sticky.spec', 'sticky.build'] as const) expect(MESSAGE_REGISTRY[type].capability, type).toBe('session.create');
    expect(MESSAGE_REGISTRY['sticky.build'].payload.safeParse({ note: 'Checkout', hash: 'a'.repeat(64) }).success).toBe(true);
    // The daemon composes the text again: a caller gives no text, no slug, no plan.
    for (const extra of [{ text: 'Build a rocket.' }, { slug: 'checkout' }, { plan: '### 1. Rocket' }, { start: true }]) {
      expect(MESSAGE_REGISTRY['sticky.build'].payload.safeParse({ note: 'Checkout', hash: 'a'.repeat(64), ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    for (const action of STICKY_ACTIONS) expect(AUDIT_ACTIONS, action).toContain(action);
  });

  it('every member gives feedback, a Viewer too; it is decided with session.drive; its author withdraws it; everyone reads it (D4.1, D4.4)', () => {
    expect(CAPABILITIES).toContain('feedback.give');
    for (const role of ROLES) expect(can(role, 'feedback.give'), role).toBe(true);
    expect(MESSAGE_REGISTRY['sticky.feedback.create'].capability).toBe('feedback.give');
    expect(MESSAGE_REGISTRY['sticky.feedback.create'].rate).toBe('suggestion');
    expect(MESSAGE_REGISTRY['sticky.feedback.withdraw'].capability).toBe('owner-checked-in-handler');
    expect(MESSAGE_REGISTRY['sticky.feedback.accept'].capability).toBe('session.drive');
    expect(MESSAGE_REGISTRY['sticky.feedback.reject'].capability).toBe('session.drive');
    expect(MESSAGE_REGISTRY['sticky.feedback.list'].capability).toBe('file.read');
    expect(MESSAGE_REGISTRY['sticky.feedback.list'].sizeRule).toBe('list');
    expect(MESSAGE_REGISTRY['sticky.feedback.updated'].capability).toBe('file.read');
    for (const action of FEEDBACK_ACTIONS) expect(AUDIT_ACTIONS, action).toContain(action);
  });

  it('an accept says nothing but which feedback: a reviewer does not edit feedback (D4.7)', () => {
    expect(MESSAGE_REGISTRY['sticky.feedback.accept'].payload.safeParse({ feedbackId: 'fb_1' }).success).toBe(true);
    expect(MESSAGE_REGISTRY['sticky.feedback.accept'].payload.safeParse({ feedbackId: 'fb_1', text: 'my own words' }).success).toBe(false);
  });

  it('a NoteInfo says nothing of the content but the links: no excerpt, no size, no time', () => {
    expect(noteInfoSchema.safeParse(homeNote).success).toBe(true);
    for (const extra of [{ excerpt: 'The cart' }, { size: 12 }, { mtime: 1 }, { path: 'notes/Home.md' }]) expect(noteInfoSchema.safeParse({ ...homeNote, ...extra }).success, JSON.stringify(extra)).toBe(false);
  });
});

describe('what sticky.json stores, from its first version on (D4.3, D5.2, D6.3)', () => {
  const member = { kind: 'member', user: { userId: 'dev:amy', displayName: 'Amy' } } as const;
  const outsider = { kind: 'outside', source: 'slack', name: 'Mei Chen', externalId: 'U012ABCDEF' } as const;
  const waiting = { id: 'fb_1', note: 'Home', text: 'Add a dark mode.', author: member, status: 'waiting', createdAt: 1 } as const;
  const decided = { decidedBy: { userId: 'dev:ian', displayName: 'Ian' }, decidedAt: 2 } as const;

  it('feedback of a member and of a person outside the workspace, waiting or decided', () => {
    for (const entry of [waiting, { ...waiting, author: outsider, cut: true }, { ...waiting, status: 'accepted', ...decided }, { ...waiting, status: 'rejected', ...decided, rejectReason: 'Not now' }, { ...waiting, status: 'withdrawn' }]) {
      const parsed = feedbackSchema.safeParse(entry);
      expect(parsed.success, JSON.stringify(entry)).toBe(true);
    }
  });

  it('refuses what no step of the feedback writes', () => {
    for (const entry of [
      { ...waiting, ...decided },
      { ...waiting, status: 'accepted' },
      { ...waiting, status: 'accepted', decidedBy: decided.decidedBy },
      { ...waiting, status: 'accepted', ...decided, rejectReason: 'x' },
      { ...waiting, cut: true },
      { ...waiting, note: 'a/b' },
      { ...waiting, text: '' },
      { ...waiting, text: 'x'.repeat(4001) },
      { ...waiting, author: { ...outsider, externalId: '12345678901234567' } },
      { ...waiting, author: { ...outsider, source: 'discord' } },
      { ...waiting, author: { ...outsider, name: '' } },
      { ...waiting, author: { kind: 'outside', source: 'teams', name: 'Mei', externalId: 'U012ABCDEF' } },
    ]) expect(feedbackSchema.safeParse(entry).success, JSON.stringify(entry)).toBe(false);
  });

  it('one cursor per source, with the channel it belongs to; a build names its note, its topic, who and the hash', () => {
    expect(stickyCursorsSchema.safeParse({}).success).toBe(true);
    expect(stickyCursorsSchema.safeParse({ slack: { channel: 'C012ABCDEF', after: '1731300000.000100' }, discord: { channel: '123456789012345678', after: '123456789012345679' } }).success).toBe(true);
    for (const cursors of [{ slack: { channel: 'D012ABCDEF', after: '1.2' } }, { discord: { channel: '1234', after: '123456789012345679' } }, { teams: {} }]) expect(stickyCursorsSchema.safeParse(cursors).success, JSON.stringify(cursors)).toBe(false);
    const build = { note: 'Home', topicId: 'tp_1', by: { userId: 'dev:ian', displayName: 'Ian' }, at: 1, hash: 'a'.repeat(64) };
    expect(noteBuildSchema.safeParse(build).success).toBe(true);
    expect(noteBuildSchema.safeParse({ ...build, hash: 'A'.repeat(64) }).success).toBe(false);
  });

  it('a connected channel id and bot token have their source’s form before anything is fetched (D6.2): what is no id or no token is refused, never repaired', () => {
    for (const id of ['C0123ABCD', 'G0123ABCDEF', `C${'A'.repeat(31)}`]) expect(isOutsideChannelId('slack', id), id).toBe(true);
    for (const id of ['C0123/../x', 'c0123abcd', 'D0123ABCD', 'C0123', `C${'A'.repeat(32)}`, 'C0123ABCD ', ' C0123ABCD', 'C0123ABCD\n', '123456789012345678']) expect(isOutsideChannelId('slack', id), id).toBe(false);
    for (const id of ['12345678901234567', '123456789012345678', '12345678901234567890']) expect(isOutsideChannelId('discord', id), id).toBe(true);
    for (const id of ['1234567890123456', '123456789012345678901', '12345678901234567a', '../123456789012345678', 'C0123ABCD', '123456789012345678/messages']) expect(isOutsideChannelId('discord', id), id).toBe(false);
    for (const token of ['xoxb-' + '1234567890123-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx', 'xoxb-1']) expect(isOutsideBotToken('slack', token), token).toBe(true);
    for (const token of ['xoxp-' + '1234567890123-AbCd', 'xoxb-', 'xoxb-abc def', 'xoxb-abc\r\nX-Other: 1', 'Bearer xoxb-abc', `xoxb-${'a'.repeat(251)}`, '']) expect(isOutsideBotToken('slack', token), token).toBe(false);
    for (const token of ['MTI3NDU2Nzg5MDEyMzQ1Njc4.GaBcDe.' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab', 'a'.repeat(20), 'a'.repeat(OUTSIDE_TOKEN_MAX_CHARS)]) expect(isOutsideBotToken('discord', token), token).toBe(true);
    for (const token of ['a'.repeat(19), 'a'.repeat(OUTSIDE_TOKEN_MAX_CHARS + 1), 'Bot MTI3NDU2Nzg5MDEyMzQ1Njc4', 'MTI3NDU2Nzg5MDEyMzQ1Njc4\nX', 'MTI3NDU2Nzg5MDEyMzQ1Njc4/../x']) expect(isOutsideBotToken('discord', token), token).toBe(false);
  });
});

describe('Claude for the sticky notes, a session of purpose `notes` (D3.1)', () => {
  it('no topic, no item, the main workspace, its mode fixed: confined like a topic’s discussion', () => {
    expect(AGENT_PURPOSES).toContain('notes');
    expect(confinedPurpose('notes')).toBe(true);
    expect(agentSessionSchema.safeParse(notesSession).success).toBe(true);
    expect(agentSessionSchema.safeParse({ ...notesSession, topicId: 'tp_1', topicName: 'Checkout' }).success).toBe(false);
    expect(agentSessionSchema.safeParse({ ...notesSession, itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, attempt: 1 }).success).toBe(false);
    expect(agentSessionSchema.safeParse({ ...notesSession, root: { kind: 'worktree', worktreeId: 'wt_1' } }).success).toBe(false);
    expect(agentSessionSchema.safeParse({ ...notesSession, modeChoice: 'auto' }).success).toBe(false);
    expect(agentSessionSchema.safeParse({ ...notesSession, permissionMode: 'auto' }).success).toBe(false);
  });
});

// ── the code of the tag ─────────────────────────────────────────────────────────────────────────────────────────────

let scratch: string | null = null;
afterAll(async () => {
  if (scratch !== null) await rm(scratch, { recursive: true, force: true });
});

/**
 * The protocol package of PROTOCOL_6_TAG in a scratch folder: `git archive`, as protocol6.test.ts gets v0.6.0's, or
 * `$SMURG_PUBLISHED_TREES/<tag>/`; its dependencies are this checkout's. Or why it cannot be had (a shallow clone has
 * no tags).
 */
async function protocolOfTheTag(): Promise<{ readonly src: string } | { readonly missing: string }> {
  scratch ??= await mkdtemp(join(tmpdir(), 'smurg-protocol7-'));
  const into = scratch;
  const given = process.env['SMURG_PUBLISHED_TREES'];
  try {
    if (given !== undefined && given !== '') {
      await cp(join(given, PROTOCOL_6_TAG, 'packages', 'protocol'), join(into, 'packages', 'protocol'), { recursive: true, filter: (source) => !source.split('/').includes('node_modules') });
      await cp(join(given, PROTOCOL_6_TAG, 'tsconfig.base.json'), join(into, 'tsconfig.base.json')).catch(() => cp(join(REPO, 'tsconfig.base.json'), join(into, 'tsconfig.base.json')));
    } else {
      const archive = join(into, 'tag.tar');
      await run('git', ['-C', REPO, 'archive', '--format=tar', '-o', archive, PROTOCOL_6_TAG, 'packages/protocol', 'tsconfig.base.json'], { maxBuffer: 64 * 1024 * 1024 });
      await run('tar', ['-xf', archive, '-C', into]);
    }
  } catch (err) {
    return { missing: `the protocol package of ${PROTOCOL_6_TAG} could not be had (no tag: a shallow checkout?): ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}` };
  }
  await symlink(join(REPO, 'packages', 'protocol', 'node_modules'), join(into, 'packages', 'protocol', 'node_modules'));
  const version = (JSON.parse(await readFile(join(into, 'packages', 'protocol', 'package.json'), 'utf8')) as { version: string }).version;
  if (`v${version}` !== PROTOCOL_6_TAG) return { missing: `the tree for ${PROTOCOL_6_TAG} says it is ${version}` };
  return { src: join(into, 'packages', 'protocol', 'src') };
}
