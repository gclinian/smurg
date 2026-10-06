// @vitest-environment node
// The host store: session.host.get once per logical channel, then the event session.host.
import { describe, expect, it } from 'vitest';
import { answerLoads, setupStores } from '../../testing/stores.ts';
import { selectAccount, selectHostState } from './host.ts';

describe('host store', () => {
  it('asks once per channel and follows session.host', async () => {
    const { conn, stores, admit, flush } = setupStores();
    expect(selectHostState(stores.host.getState())).toBeNull();
    admit();
    expect(conn.requestsOf('session.host.get')).toHaveLength(1);
    answerLoads(conn, { 'session.host.get': { account: { state: 'ok', sessions: 2 }, mainProjectSettings: 'used' } });
    await flush();
    expect(stores.host.getState()).toMatchObject({ status: 'ready', host: { mainProjectSettings: 'used' } });
    expect(selectAccount(stores.host.getState())).toEqual({ state: 'ok', sessions: 2 });

    conn.emit('session.host', { account: { state: 'usage-limit', resetsAt: 1_800_000_000_000, sessions: 4 }, mainProjectSettings: 'used' });
    expect(selectAccount(stores.host.getState())).toEqual({ state: 'usage-limit', resetsAt: 1_800_000_000_000, sessions: 4 });

    // A resumed channel asks nothing; a new one asks again.
    admit({ resumed: true });
    expect(conn.requestsOf('session.host.get')).toHaveLength(1);
    admit({ resumed: false, channelId: 'ch_2' });
    expect(selectHostState(stores.host.getState())).toBeNull();
    expect(conn.requestsOf('session.host.get')).toHaveLength(2);
  });
});
