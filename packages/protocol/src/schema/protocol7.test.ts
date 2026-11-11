// What protocol 7 added (smurg 0.8.0, DESIGN 0.8.0 D3, D8.2): the Welcome's `protocol`, and Claude for the sticky notes
// as a session of purpose `notes`. Every message has samples in message-samples.fixture.ts (run by registry.test.ts);
// this file holds the rules a sample alone does not say, and states, shape by shape, what a peer of protocol 6 meets:
// the Welcome gained a required key, so this side refuses protocol 6's; a session only gained an enum value, so for it
// the meaningful direction is the other one: protocol 6's own strict schema (the code of tag v0.7.0, the last
// published smurg of protocol 6) refuses a session of purpose `notes`.
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../constants.ts';
import { confinedPurpose } from '../tools.ts';
import { AGENT_PURPOSES, agentSessionSchema } from './entities.ts';
import { verdictSchema, welcomeSchema } from './handshake.ts';
import { agentSession, notesSession, publicSettings } from './message-samples.fixture.ts';

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
