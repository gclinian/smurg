// @vitest-environment node
// The inbox store: the member's items live from the wire, the two groups and the two counts (DESIGN §5.12 item 1),
// "seen", dismissing, and which arrivals are worth telling.
import { SmurgError } from '@smurg/protocol';
import { buildInboxItem } from '@smurg/protocol/testing';
import { describe, expect, it } from 'vitest';
import { answerLoads, setupStores } from '../../testing/stores.ts';
import { onlyMine, selectInboxCounts, selectInboxGroups } from './inbox.ts';

const ME = 'dev:amy';
const IAN = { userId: 'dev:host', displayName: 'Ian' };
const MEI = { userId: 'dev:mei', displayName: 'Mei' };

async function ready(items = [buildInboxItem('question')]) {
  const ctx = setupStores();
  ctx.admit();
  answerLoads(ctx.conn, { 'inbox.list': { items, hasMore: false } });
  await ctx.flush();
  return ctx;
}

describe('inbox store', () => {
  it('reads every page of inbox.list (key order) and replaces the list after a full resync', async () => {
    const { conn, stores, admit, flush } = setupStores();
    admit();
    conn.respond('inbox.list', { items: [buildInboxItem('question')], hasMore: true });
    await flush();
    expect(conn.lastRequest('inbox.list')?.payload).toEqual({ after: 'question:q_1' });
    conn.respond('inbox.list', { items: [buildInboxItem('permission')], hasMore: false });
    await flush();
    expect([...stores.inbox.getState().items.keys()]).toEqual(['question:q_1', 'permission:pr_1']);
    expect(stores.inbox.getState().status).toBe('ready');

    admit({ resumed: false, channelId: 'ch_2' });
    expect(stores.inbox.getState().items.size).toBe(0);
    conn.respond('inbox.list', { items: [buildInboxItem('mention')], hasMore: false });
    await flush();
    expect([...stores.inbox.getState().items.keys()]).toEqual(['mention:nt_1']);
  });

  it('inbox.changed upserts by key and removes by key: an item leaves when the thing is settled', async () => {
    const { conn, stores } = await ready();
    conn.emit('inbox.changed', { upsert: [buildInboxItem('question', { voted: 1 }), buildInboxItem('report')], remove: [] });
    expect(stores.inbox.getState().items.get('question:q_1')?.voted).toBe(1);
    expect(stores.inbox.getState().items.size).toBe(2);
    conn.emit('inbox.changed', { upsert: [], remove: ['question:q_1', 'gone:x'] });
    expect([...stores.inbox.getState().items.keys()]).toEqual(['report:tp_1.cart-api']);
  });

  it('the two counts: what an agent or a plan is stopped on, and the rest', async () => {
    const { stores } = await ready([
      buildInboxItem('question'),
      buildInboxItem('vote'),
      buildInboxItem('permission'),
      buildInboxItem('attention'),
      buildInboxItem('attention', { key: 'attention:storage:x', subject: 'storage', waiting: false, itemId: undefined, item: undefined, topicId: undefined, sessionId: undefined, target: { kind: 'console', section: 'sessions' } }),
      buildInboxItem('suggestion'),
      buildInboxItem('report'),
      buildInboxItem('merge'),
      buildInboxItem('mention'),
      buildInboxItem('result'),
    ]);
    expect(selectInboxCounts(stores.inbox.getState())).toEqual({ waiting: 4, look: 6 });
  });

  it('"Agents are waiting": the rows only I can settle first, then the oldest first', async () => {
    const { stores } = await ready([
      buildInboxItem('vote', { key: 'vote:q_9', at: 1 }),
      buildInboxItem('question', { key: 'question:q_2', at: 30, alsoFor: [MEI] }),
      buildInboxItem('permission', { key: 'permission:pr_new', at: 20 }),
      buildInboxItem('question', { key: 'question:q_old', at: 10 }),
      // An escalated copy: it waits for Ian, I may step in.
      buildInboxItem('permission', { key: 'permission:pr_ian', at: 5, waitsFor: IAN, waitsForOffline: false, escalated: true }),
    ]);
    const { waiting } = selectInboxGroups(stores.inbox.getState(), ME);
    expect(waiting.map((item) => item.key)).toEqual(['question:q_old', 'permission:pr_new', 'vote:q_9', 'permission:pr_ian', 'question:q_2']);
  });

  it('onlyMine: nobody else is named, and it does not wait for somebody else', () => {
    expect(onlyMine(buildInboxItem('question'), ME)).toBe(true);
    expect(onlyMine(buildInboxItem('question', { alsoFor: [MEI] }), ME)).toBe(false);
    expect(onlyMine(buildInboxItem('question', { alsoForMore: 2 }), ME)).toBe(false);
    expect(onlyMine(buildInboxItem('permission', { waitsFor: IAN, waitsForOffline: true }), ME)).toBe(false);
    expect(onlyMine(buildInboxItem('permission', { waitsFor: { userId: ME, displayName: 'Amy' }, waitsForOffline: false }), ME)).toBe(true);
    // A vote is advice: the decider can submit without it.
    expect(onlyMine(buildInboxItem('vote'), ME)).toBe(false);
  });

  it('"For you to look at": newest first, a merge that other items wait for before the rest', async () => {
    const { stores } = await ready([
      buildInboxItem('suggestion', { at: 50 }),
      buildInboxItem('report', { at: 70 }),
      buildInboxItem('merge', { key: 'merge:mr_plain', at: 90 }),
      buildInboxItem('merge', { key: 'merge:mr_blocks', at: 10, unblocks: [6] }),
      buildInboxItem('mention', { at: 60 }),
    ]);
    const { look, waiting } = selectInboxGroups(stores.inbox.getState(), ME);
    expect(waiting).toEqual([]);
    expect(look.map((item) => item.key)).toEqual(['merge:mr_blocks', 'merge:mr_plain', 'report:tp_1.cart-api', 'mention:nt_1', 'suggestion:sess_a.dev-amy']);
  });

  it('seen() clears "unread" at once and tells the daemon, for unread items only', async () => {
    const { conn, stores } = await ready([buildInboxItem('question'), buildInboxItem('report', { unread: false })]);
    stores.inbox.seen(['question:q_1', 'report:tp_1.cart-api', 'gone:x']);
    expect(stores.inbox.getState().items.get('question:q_1')?.unread).toBe(false);
    expect(conn.notificationsOf('inbox.seen').map((n) => n.payload)).toEqual([{ keys: ['question:q_1'] }]);
    stores.inbox.seen(['question:q_1']);
    expect(conn.notificationsOf('inbox.seen')).toHaveLength(1);
    // "Unread" comes back by itself (everyone voted): the daemon says so.
    conn.emit('inbox.changed', { upsert: [buildInboxItem('question', { unread: true, allVoted: true, voted: 1 })], remove: [] });
    expect(stores.inbox.getState().items.get('question:q_1')).toMatchObject({ unread: true, allVoted: true });
  });

  it('seen() while the host is away drops the notice and keeps the mark for this screen', async () => {
    const { conn, stores } = await ready();
    conn.hostOffline();
    stores.inbox.seen(['question:q_1']);
    expect(conn.notificationsOf('inbox.seen')).toHaveLength(0);
    expect(stores.inbox.getState().items.get('question:q_1')?.unread).toBe(false);
  });

  it('dismiss() asks the daemon; the item leaves with the daemon\'s inbox.changed, and a refusal is the caller\'s to show', async () => {
    const { conn, stores } = await ready([buildInboxItem('mention'), buildInboxItem('question')]);
    const dismissing = stores.inbox.dismiss('mention:nt_1');
    expect(conn.lastRequest('inbox.dismiss')?.payload).toEqual({ key: 'mention:nt_1' });
    expect(stores.inbox.getState().items.has('mention:nt_1')).toBe(true);
    conn.emit('inbox.changed', { upsert: [], remove: ['mention:nt_1'] });
    conn.respond('inbox.dismiss', {});
    await dismissing;
    expect(stores.inbox.getState().items.has('mention:nt_1')).toBe(false);
    const refused = stores.inbox.dismiss('question:q_1');
    conn.fail('inbox.dismiss', new SmurgError('conflict', 'This item leaves the inbox when it is settled.'));
    await expect(refused).rejects.toBeInstanceOf(SmurgError);
  });

  it('arrivals: a waiting item that comes in by itself after the first snapshot, once', async () => {
    const { conn, stores, admit, flush } = setupStores();
    admit();
    // Before the snapshot: everything would look new.
    conn.emit('inbox.changed', { upsert: [buildInboxItem('permission', { key: 'permission:early' })], remove: [] });
    answerLoads(conn, { 'inbox.list': { items: [buildInboxItem('question')], hasMore: false } });
    await flush();
    expect(stores.inbox.getState().arrivals).toEqual([]);

    conn.emit('inbox.changed', { upsert: [buildInboxItem('permission'), buildInboxItem('report'), buildInboxItem('question', { voted: 1 })], remove: [] });
    expect(stores.inbox.getState().arrivals.map((arrival) => arrival.item.key)).toEqual(['permission:pr_1']);
    // The same item again (its row changed) is not a new arrival.
    conn.emit('inbox.changed', { upsert: [buildInboxItem('permission', { escalated: true, waitsFor: IAN, waitsForOffline: false })], remove: [] });
    expect(stores.inbox.getState().arrivals).toHaveLength(1);
    // Gone and back: it waits again, so it is told again.
    conn.emit('inbox.changed', { upsert: [], remove: ['permission:pr_1'] });
    conn.emit('inbox.changed', { upsert: [buildInboxItem('permission')], remove: [] });
    const arrivals = stores.inbox.getState().arrivals;
    expect(arrivals).toHaveLength(2);
    expect(arrivals[1]!.id).toBeGreaterThan(arrivals[0]!.id);
  });
});
