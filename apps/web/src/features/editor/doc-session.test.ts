import { DOC_TEXT_NAME, MAIN_ROOT, SmurgError, fileRefKey, type FileRef, type Role } from '@smurg/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createWorkspaceStores } from '../../lib/stores/index.ts';
import { FakeConnection } from '../../testing/fake-connection.ts';
import { T0, makeAgentLock, makeWelcome } from '../../testing/fixtures.ts';
import { createManualScheduler } from '../../testing/services.tsx';
import { createDocSessionRegistry, spliceText, type DocSessionRegistry } from './doc-session.ts';
import { bridgeDocs, testUser, type TestRoom } from './testing/test-room.ts';

const FILE: FileRef = { root: MAIN_ROOT, path: 'src/app.ts' };
const KEY = fileRefKey(FILE);
const TEXT = 'const greeting = "你好";\nconsole.log(greeting) // 🙂\n';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(options: { role?: Role; name?: string; rooms?: Map<string, TestRoom>; canWrite?: boolean; withRegistry?: boolean } = {}) {
  const conn = new FakeConnection();
  const scheduler = createManualScheduler(T0);
  const { stores, dispose } = createWorkspaceStores(conn, { scheduler });
  conn.start();
  const name = options.name ?? 'Amy';
  const bridge = bridgeDocs(conn, testUser(name), options.rooms, options.canWrite === undefined ? {} : { canWrite: options.canWrite });
  const role = options.role ?? 'editor';
  conn.admit(makeWelcome({ role, userId: `dev:${name.toLowerCase()}`, displayName: name }));
  let now = T0;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  let registry: DocSessionRegistry | null = null;
  const startRegistry = (): DocSessionRegistry => {
    registry = createDocSessionRegistry({ docs: stores.docs, connection: stores.connection }, { now: clock.now });
    return registry;
  };
  if (options.withRegistry !== false) startRegistry();
  cleanups.push(() => {
    registry?.dispose();
    dispose();
  });
  /** Lets request promises settle, then moves doc.* traffic until quiet. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      await flush();
      bridge.pump();
    }
  };
  return { conn, stores, bridge, scheduler, clock, settle, startRegistry, registry: () => registry, role };
}

async function openFile(ctx: ReturnType<typeof setup>): Promise<void> {
  void ctx.stores.docs.open(FILE).catch(() => {});
  await ctx.settle();
}

describe('DocSession: one replica + provider per open document', () => {
  it('buffers doc.* messages that arrive before subscribe: a session created later still gets step 1 and the awareness snapshot', async () => {
    const other = setup({ name: 'Bob' });
    const room = other.bridge.addFile(FILE, TEXT);
    await openFile(other);
    // Bob has a cursor in the file: the snapshot for Amy will carry it.
    other.registry()?.get(KEY)?.awareness.setLocalStateField('selection', null);
    await other.settle();

    const amy = setup({ rooms: other.bridge.rooms, withRegistry: false });
    await openFile(amy);
    // Nobody subscribed yet: the docs store holds sync step 1 and the snapshot.
    expect(amy.stores.docs.getState().docs.get(KEY)?.status).toBe('open');
    const registry = amy.startRegistry();
    await amy.settle();
    const session = registry.get(KEY);
    expect(session?.getState().replicaSynced).toBe(true);
    expect(session?.ytext.toString()).toBe(TEXT);
    const bobId = other.registry()?.get(KEY)?.doc.clientID;
    const seen = session?.awareness.getStates().get(bobId ?? -1) as { user?: { name: string } } | undefined;
    expect(seen?.user?.name).toBe('Bob');
    expect(room.text).toBe(TEXT);
  });

  it('binds on the first sync only: a reconnect on the same epoch keeps the replica and merges edits made while offline', async () => {
    const ctx = setup();
    const room = ctx.bridge.addFile(FILE, TEXT);
    await openFile(ctx);
    const session = ctx.registry()?.get(KEY);
    expect(session?.getState()).toMatchObject({ replica: 0, replicaSynced: true, live: true });

    // The channel could not be resumed: the daemon forgot the subscription, the room (same epoch) is still there.
    ctx.bridge.dropChannel();
    ctx.conn.admit(makeWelcome({ role: 'editor', channelId: 'ch_2' }), { resumed: false });
    expect(session?.getState().live).toBe(false);
    session?.ytext.insert(0, '// 離線時打的字 ✍️\n');
    await ctx.settle();

    expect(ctx.registry()?.get(KEY)).toBe(session);
    expect(session?.getState()).toMatchObject({ replica: 0, replicaSynced: true, live: true });
    expect(room.text).toBe(`// 離線時打的字 ✍️\n${TEXT}`);
    expect(session?.ytext.toString()).toBe(room.text);
  });

  it('epoch reset: doc.reset drops the replica and a fresh Y.Doc re-syncs (the text is never duplicated)', async () => {
    const ctx = setup();
    const room = ctx.bridge.addFile(FILE, TEXT);
    await openFile(ctx);
    const session = ctx.registry()?.get(KEY);
    const oldDoc = session?.doc;
    room.reset('重新從磁碟載入的內容\n');
    await ctx.settle();
    expect(session?.getState()).toMatchObject({ replica: 1, replicaSynced: true, live: true, epoch: room.epoch });
    expect(session?.doc).not.toBe(oldDoc);
    expect(session?.ytext.toString()).toBe('重新從磁碟載入的內容\n');
    expect(room.text).toBe('重新從磁碟載入的內容\n');
    expect(session?.getState().dropped?.reason).toBe('epoch');
  });

  it('a reopen after a full resync with a NEW epoch (the daemon restarted) drops the replica instead of merging it, then puts back the edit the daemon lost', async () => {
    const ctx = setup();
    const room = ctx.bridge.addFile(FILE, TEXT);
    await openFile(ctx);
    const session = ctx.registry()?.get(KEY);
    session?.ytext.insert(0, 'x');
    await ctx.settle();
    ctx.bridge.dropChannel();
    room.reset(TEXT); // no members any more: only the doc and the epoch change (the daemon never saved 'x')
    ctx.conn.admit(makeWelcome({ role: 'editor', channelId: 'ch_2' }), { resumed: false });
    await ctx.settle();
    expect(session?.getState()).toMatchObject({ replica: 1, replicaSynced: true, epoch: room.epoch, recovery: null });
    // Never the two replicas merged (that would duplicate the whole text): the daemon's text plus our one edit.
    expect(session?.ytext.toString()).toBe(`x${TEXT}`);
    expect(room.text).toBe(`x${TEXT}`);
    expect(session?.getState().dropped).toMatchObject({ reason: 'epoch', outcome: 'restored' });
  });

  describe('text typed while the host was unreachable survives a new epoch', () => {
    /** Host outage: what the client sends from now on never reaches the daemon. Then the daemon comes back with `diskText`. */
    async function outageThenRestart(ctx: ReturnType<typeof setup>, room: TestRoom, typeOffline: () => void, diskText: string): Promise<void> {
      ctx.clock.advance(5_000);
      typeOffline();
      ctx.bridge.dropChannel(); // the queued doc.sync updates die with the old daemon
      room.reset(diskText);
      ctx.conn.admit(makeWelcome({ role: 'editor', channelId: 'ch_2' }), { resumed: false });
      await ctx.settle();
    }

    it('daemon restart while a teammate typed offline: the typed line is applied to the new epoch and saved, not discarded', async () => {
      const ctx = setup();
      const room = ctx.bridge.addFile(FILE, TEXT);
      await openFile(ctx);
      const session = ctx.registry()?.get(KEY);
      await outageThenRestart(ctx, room, () => session?.ytext.insert(TEXT.length, '離線時打的一行 ✍️\n'), TEXT);
      expect(session?.ytext.toString()).toBe(`${TEXT}離線時打的一行 ✍️\n`);
      expect(room.text).toBe(`${TEXT}離線時打的一行 ✍️\n`);
      expect(session?.getState()).toMatchObject({ replica: 1, replicaSynced: true, recovery: null, pendingSave: true });
      expect(session?.getState().dropped).toMatchObject({ reason: 'epoch', outcome: 'restored' });
    });

    it('the daemon had the edits already (saved before it stopped): nothing is applied twice', async () => {
      const ctx = setup();
      const room = ctx.bridge.addFile(FILE, TEXT);
      await openFile(ctx);
      const session = ctx.registry()?.get(KEY);
      session?.ytext.insert(0, 'saved\n');
      await ctx.settle();
      ctx.bridge.dropChannel();
      room.reset(`saved\n${TEXT}`);
      ctx.conn.admit(makeWelcome({ role: 'editor', channelId: 'ch_2' }), { resumed: false });
      await ctx.settle();
      expect(session?.ytext.toString()).toBe(`saved\n${TEXT}`);
      expect(room.text).toBe(`saved\n${TEXT}`);
      expect(session?.getState()).toMatchObject({ recovery: null, dropped: { reason: 'epoch', outcome: 'none' } });
    });

    it('the file changed on the host meanwhile: the offline text is kept as a recovery, then put back on request', async () => {
      const ctx = setup();
      const room = ctx.bridge.addFile(FILE, TEXT);
      await openFile(ctx);
      const session = ctx.registry()?.get(KEY);
      const mine = `${TEXT}我的離線修改\n`;
      await outageThenRestart(ctx, room, () => session?.ytext.insert(TEXT.length, '我的離線修改\n'), `// 主人改過\n${TEXT}`);
      // The daemon's text wins for now, and nothing of ours was sent…
      expect(session?.ytext.toString()).toBe(`// 主人改過\n${TEXT}`);
      expect(room.text).toBe(`// 主人改過\n${TEXT}`);
      // …but our text is still here, not discarded.
      expect(session?.getState().recovery).toMatchObject({ text: mine, reason: 'epoch' });
      expect(session?.getState().dropped).toMatchObject({ reason: 'epoch', outcome: 'recovery' });
      expect(session?.applyRecovery()).toBe(true);
      await ctx.settle();
      expect(session?.getState().recovery).toBeNull();
      expect(room.text).toBe(mine);
      expect(session?.ytext.toString()).toBe(mine);
    });

    it('a recovery can be discarded, and is never applied while the file is not editable', async () => {
      const ctx = setup();
      const room = ctx.bridge.addFile(FILE, TEXT);
      await openFile(ctx);
      const session = ctx.registry()?.get(KEY);
      await outageThenRestart(ctx, room, () => session?.ytext.insert(0, 'mine '), 'changed on the host\n');
      expect(session?.getState().recovery?.text).toBe(`mine ${TEXT}`);
      room.agentLock = makeAgentLock(FILE.path);
      ctx.conn.emit('lock.state', { file: FILE, lock: room.agentLock });
      expect(session?.applyRecovery()).toBe(false);
      expect(session?.getState().recovery).not.toBeNull();
      session?.discardRecovery();
      expect(session?.getState().recovery).toBeNull();
      await ctx.settle();
      expect(room.text).toBe('changed on the host\n');
    });

    it('edits confirmed by a later doc.saved are the new base: offline typing after them is restored on its own', async () => {
      const ctx = setup();
      const room = ctx.bridge.addFile(FILE, TEXT);
      await openFile(ctx);
      const session = ctx.registry()?.get(KEY);
      session?.ytext.insert(0, 'a');
      await ctx.settle();
      ctx.clock.advance(3_000); // the save arrives well after the keystroke: it contains it
      ctx.conn.emit('doc.saved', { docId: room.id, file: FILE, hash: 'a'.repeat(64), at: T0 + 3_000 });
      await outageThenRestart(ctx, room, () => session?.ytext.insert(1, 'b'), `a${TEXT}`);
      expect(session?.ytext.toString()).toBe(`ab${TEXT}`);
      expect(room.text).toBe(`ab${TEXT}`);
      expect(session?.getState().recovery).toBeNull();
    });

    it('a doc.saved right behind a keystroke confirms nothing: the edit is still recoverable if the daemon lost it', async () => {
      const ctx = setup();
      const room = ctx.bridge.addFile(FILE, TEXT);
      await openFile(ctx);
      const session = ctx.registry()?.get(KEY);
      session?.ytext.insert(0, 'a');
      ctx.clock.advance(100); // a save for something older, which did not include 'a'
      ctx.conn.emit('doc.saved', { docId: room.id, file: FILE, hash: 'b'.repeat(64), at: T0 + 100 });
      ctx.bridge.dropChannel();
      room.reset(TEXT);
      ctx.conn.admit(makeWelcome({ role: 'editor', channelId: 'ch_2' }), { resumed: false });
      await ctx.settle();
      expect(session?.ytext.toString()).toBe(`a${TEXT}`);
      expect(room.text).toBe(`a${TEXT}`);
    });

    it('no local edits: an epoch change just re-syncs (no recovery, the banner does not claim a loss)', async () => {
      const ctx = setup();
      const room = ctx.bridge.addFile(FILE, TEXT);
      await openFile(ctx);
      const session = ctx.registry()?.get(KEY);
      room.reset('new text\n');
      await ctx.settle();
      expect(session?.getState()).toMatchObject({ recovery: null, dropped: { reason: 'epoch', outcome: 'none' } });
      expect(session?.ytext.toString()).toBe('new text\n');
    });
  });

  it('spliceText never splits a surrogate pair', () => {
    const doc = new Y.Doc();
    doc.getText(DOC_TEXT_NAME).insert(0, 'a😀b');
    spliceText(doc, 'a😁b');
    expect(doc.getText(DOC_TEXT_NAME).toString()).toBe('a😁b');
    spliceText(doc, '😁b');
    expect(doc.getText(DOC_TEXT_NAME).toString()).toBe('😁b');
  });

  it('doc.rejected (read-only): the local change is dropped and the replica re-syncs from the daemon', async () => {
    const ctx = setup();
    const room = ctx.bridge.addFile(FILE, TEXT, { canWrite: false });
    await openFile(ctx);
    const session = ctx.registry()?.get(KEY);
    session?.ytext.insert(0, '不該被接受的修改');
    expect(session?.getState().pendingSave).toBe(true);
    await ctx.settle();
    expect(ctx.stores.docs.getState().docs.get(KEY)?.rejected?.reason).toBe('read-only');
    expect(session?.getState()).toMatchObject({ replica: 1, replicaSynced: true, pendingSave: false });
    expect(session?.ytext.toString()).toBe(TEXT);
    expect(room.text).toBe(TEXT);
    expect(room.dropped.length).toBeGreaterThan(0);
  });

  it('doc.rejected (forbidden, a viewer that bypassed the read-only UI): dropped and re-synced as well', async () => {
    const ctx = setup({ role: 'viewer', canWrite: false });
    const room = ctx.bridge.addFile(FILE, TEXT);
    await openFile(ctx);
    const session = ctx.registry()?.get(KEY);
    session?.ytext.insert(0, 'rm -rf / # ');
    await ctx.settle();
    expect(ctx.stores.docs.getState().docs.get(KEY)?.rejected?.reason).toBe('forbidden');
    expect(session?.ytext.toString()).toBe(TEXT);
    expect(room.text).toBe(TEXT);
  });

  it('doc.rejected (agent-locked): the daemon applied then reverted the keystroke, so the replica converges as it is', async () => {
    const amy = setup();
    const room = amy.bridge.addFile(FILE, TEXT);
    const bob = setup({ name: 'Bob', rooms: amy.bridge.rooms });
    await openFile(amy);
    await openFile(bob);
    room.agentLock = makeAgentLock(FILE.path);
    const session = amy.registry()?.get(KEY);
    session?.ytext.insert(5, 'XYZ'); // typed before lock.state reached Amy
    await amy.settle();
    await bob.settle();
    expect(amy.stores.docs.getState().docs.get(KEY)?.rejected?.reason).toBe('agent-locked');
    expect(session?.getState()).toMatchObject({ replica: 0, pendingSave: false });
    expect(session?.ytext.toString()).toBe(TEXT);
    expect(bob.registry()?.get(KEY)?.ytext.toString()).toBe(TEXT);
    expect(room.text).toBe(TEXT);
  });

  it('two browsers co-edit one document through the daemon: CJK and emoji converge character for character', async () => {
    const amy = setup();
    const room = amy.bridge.addFile(FILE, TEXT);
    const bob = setup({ name: 'Bob', rooms: amy.bridge.rooms });
    await openFile(amy);
    await openFile(bob);
    const a = amy.registry()?.get(KEY);
    const b = bob.registry()?.get(KEY);
    a?.ytext.insert(0, '// 艾咪：嗨 👋\n');
    b?.ytext.insert(TEXT.length, '// 鮑伯：𠮷 ✅\n');
    for (let i = 0; i < 3; i++) {
      await amy.settle();
      await bob.settle();
    }
    const expected = `// 艾咪：嗨 👋\n${TEXT}// 鮑伯：𠮷 ✅\n`;
    expect(room.text).toBe(expected);
    expect(a?.ytext.toString()).toBe(expected);
    expect(b?.ytext.toString()).toBe(expected);
    // Remote presence carries the daemon's names (the CSS labels are built from them).
    const names = [...(a?.awareness.getStates().values() ?? [])].map((s) => (s as { user?: { name: string } }).user?.name).filter(Boolean);
    expect(names).toContain('Bob');
  });

  it('autosave indicator: a local edit is pending until doc.saved arrives', async () => {
    const ctx = setup();
    const room = ctx.bridge.addFile(FILE, TEXT);
    await openFile(ctx);
    const session = ctx.registry()?.get(KEY);
    expect(session?.getState().pendingSave).toBe(false);
    ctx.clock.advance(1_000);
    session?.ytext.insert(0, 'a');
    expect(session?.getState()).toMatchObject({ pendingSave: true, lastLocalEditAt: T0 + 1_000 });
    await ctx.settle();
    // Remote edits are not "mine to save".
    room.applyExternal(`${room.text}// agent\n`);
    await ctx.settle();
    expect(session?.getState().lastLocalEditAt).toBe(T0 + 1_000);
    ctx.clock.advance(500);
    ctx.conn.emit('doc.saved', { docId: room.id, file: FILE, hash: 'a'.repeat(64), at: T0 + 1_400 });
    expect(session?.getState()).toMatchObject({ pendingSave: false, lastSavedAt: T0 + 1_500 });
  });

  it('closing the document disposes the session: the daemon hears doc.close and nothing after it', async () => {
    const ctx = setup();
    ctx.bridge.addFile(FILE, TEXT);
    await openFile(ctx);
    const session = ctx.registry()?.get(KEY);
    const before = ctx.conn.notifications.length;
    ctx.stores.docs.close(KEY);
    const sentAtClose = ctx.conn.notifications.length;
    expect(ctx.conn.notifications.slice(before).map((n) => n.type)).toContain('doc.close');
    expect(ctx.registry()?.get(KEY)).toBeUndefined();
    session?.ytext.insert(0, 'after close');
    session?.awareness.setLocalStateField('selection', null);
    expect(ctx.conn.notifications.length).toBe(sentAtClose);
  });

  it('every session is disposed once the connection has ended for good', async () => {
    const ctx = setup();
    ctx.bridge.addFile(FILE, TEXT);
    await openFile(ctx);
    const session = ctx.registry()?.get(KEY);
    ctx.conn.kicked();
    expect(ctx.registry()?.get(KEY)).toBeUndefined();
    expect(session?.getState().live).toBe(false);
  });

  it('keeps the structured error of a refused doc.open (the tab explains it and offers the download)', async () => {
    const ctx = setup();
    ctx.conn.handle('doc.open', () => {
      throw new SmurgError('bad_request', 'This is a binary file and cannot be opened in the editor.', { reason: 'binary' });
    });
    const registry = ctx.registry();
    await ctx.stores.docs.open(FILE).catch((error: unknown) => registry?.get(KEY)?.setOpenFailure(error));
    expect(ctx.stores.docs.getState().docs.get(KEY)?.status).toBe('error');
    expect(registry?.get(KEY)?.getState().openFailure).toEqual({ code: 'bad_request', reason: 'binary' });
  });

  it('uses the one Y.Text every client and the daemon share (DOC_TEXT_NAME)', async () => {
    const ctx = setup();
    ctx.bridge.addFile(FILE, TEXT);
    await openFile(ctx);
    const session = ctx.registry()?.get(KEY);
    expect(session?.ytext).toBe(session?.doc.getText(DOC_TEXT_NAME));
  });
});
