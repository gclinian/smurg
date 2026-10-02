// The closed tabs of ended sessions (closed-sessions.ts): kept per workspace in this browser's storage, merged with
// what another window wrote, forgotten once the daemon no longer lists the session, bounded, and tolerant of a
// missing, corrupt or blocked storage.
import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../testing/services.tsx';
import { CLOSED_MAX_IDS, CLOSED_MAX_WORKSPACES, CLOSED_SESSIONS_KEY, createClosedSessions } from './closed-sessions.ts';

const stored = (storage: MemoryStorage): unknown => JSON.parse(storage.getItem(CLOSED_SESSIONS_KEY) ?? 'null');
const listed = (...ids: string[]): Set<string> => new Set(ids);

describe('closed session tabs (per browser, per workspace)', () => {
  it('remembers a closed tab for the workspace it belongs to, across a new page load', () => {
    const storage = new MemoryStorage();
    const first = createClosedSessions('ws_a', storage);
    let notified = 0;
    first.subscribe(() => notified++);
    first.close('ses_1');
    first.close('ses_2');
    first.close('ses_1'); // again: nothing changes for the panel
    expect([...first.getState()]).toEqual(['ses_1', 'ses_2']);
    expect(notified).toBe(2);
    expect(stored(storage)).toEqual({ ws_a: ['ses_2', 'ses_1'] });

    // A new page load of the same workspace; another workspace knows nothing about them.
    expect([...createClosedSessions('ws_a', storage).getState()].sort()).toEqual(['ses_1', 'ses_2']);
    expect(createClosedSessions('ws_b', storage).getState().size).toBe(0);
  });

  it('reopen shows the tab again', () => {
    const storage = new MemoryStorage();
    const closed = createClosedSessions('ws_a', storage);
    closed.close('ses_1');
    closed.close('ses_2');
    closed.reopen('ses_1');
    closed.reopen('ses_unknown');
    expect([...closed.getState()]).toEqual(['ses_2']);
    expect(stored(storage)).toEqual({ ws_a: ['ses_2'] });
    closed.reopen('ses_2');
    // Nothing left: nothing stays in the storage.
    expect(storage.getItem(CLOSED_SESSIONS_KEY)).toBeNull();
  });

  it("forgets the ids the daemon no longer lists, and only those; another workspace's ids are not touched", () => {
    const storage = new MemoryStorage();
    createClosedSessions('ws_b', storage).close('ses_other');
    const closed = createClosedSessions('ws_a', storage);
    closed.close('ses_1');
    closed.close('ses_2');
    let notified = 0;
    closed.subscribe(() => notified++);
    closed.retain(listed('ses_1', 'ses_2', 'ses_running'));
    expect(notified).toBe(0);
    closed.retain(listed('ses_2'));
    expect([...closed.getState()]).toEqual(['ses_2']);
    expect(stored(storage)).toEqual({ ws_b: ['ses_other'], ws_a: ['ses_2'] });
    closed.retain(listed());
    expect(closed.getState().size).toBe(0);
    expect(stored(storage)).toEqual({ ws_b: ['ses_other'] });
  });

  it('two windows of one browser: neither loses what the other closed', () => {
    const storage = new MemoryStorage();
    const left = createClosedSessions('ws_a', storage);
    const right = createClosedSessions('ws_a', storage);
    left.close('ses_1');
    right.close('ses_2');
    expect(stored(storage)).toEqual({ ws_a: ['ses_1', 'ses_2'] });
    // Each window's own panel changed only by what was closed in it.
    expect([...left.getState()]).toEqual(['ses_1']);
    expect([...right.getState()]).toEqual(['ses_2']);
    // The daemon forgot ses_1: the window that prunes leaves the other window's id alone.
    left.retain(listed('ses_2'));
    expect(stored(storage)).toEqual({ ws_a: ['ses_2'] });
    expect([...createClosedSessions('ws_a', storage).getState()]).toEqual(['ses_2']);
  });

  it('is bounded: the oldest ids of a workspace and the workspaces written longest ago go first', () => {
    const storage = new MemoryStorage();
    const closed = createClosedSessions('ws_0', storage);
    for (let i = 0; i < CLOSED_MAX_IDS + 5; i++) closed.close(`ses_${i}`);
    const ids = (stored(storage) as Record<string, string[]>)['ws_0'] as string[];
    expect(ids).toHaveLength(CLOSED_MAX_IDS);
    expect(ids[0]).toBe('ses_5');
    expect(ids.at(-1)).toBe(`ses_${CLOSED_MAX_IDS + 4}`);

    for (let i = 1; i <= CLOSED_MAX_WORKSPACES; i++) createClosedSessions(`ws_${i}`, storage).close('ses_x');
    const workspaces = Object.keys(stored(storage) as object);
    expect(workspaces).toHaveLength(CLOSED_MAX_WORKSPACES);
    expect(workspaces).not.toContain('ws_0');
    expect(workspaces.at(-1)).toBe(`ws_${CLOSED_MAX_WORKSPACES}`);
  });

  it('tolerates a corrupt, foreign or blocked storage, and no workspace yet: the tab is closed for this page load', () => {
    const corrupt = new MemoryStorage();
    corrupt.setItem(CLOSED_SESSIONS_KEY, '{not json');
    expect(createClosedSessions('ws_a', corrupt).getState().size).toBe(0);
    const foreign = new MemoryStorage();
    foreign.setItem(CLOSED_SESSIONS_KEY, JSON.stringify({ ws_a: ['ses_1', 7, '', 'ses_1', null, 'x'.repeat(500)], ws_b: 'nope', ws_c: { a: 1 } }));
    const fromForeign = createClosedSessions('ws_a', foreign);
    expect([...fromForeign.getState()]).toEqual(['ses_1']);
    fromForeign.close('ses_2');
    expect(stored(foreign)).toEqual({ ws_a: ['ses_1', 'ses_2'] });
    for (const value of ['[]', '"text"', '7', 'null']) {
      const storage = new MemoryStorage();
      storage.setItem(CLOSED_SESSIONS_KEY, value);
      expect(createClosedSessions('ws_a', storage).getState().size).toBe(0);
    }

    const blocked = {
      getItem: (): string | null => {
        throw new Error('blocked');
      },
      setItem: (): void => {
        throw new Error('blocked');
      },
      removeItem: (): void => {
        throw new Error('blocked');
      },
    };
    for (const closed of [createClosedSessions('ws_a', blocked), createClosedSessions('ws_a', null), createClosedSessions(null, new MemoryStorage())]) {
      closed.close('ses_1');
      expect([...closed.getState()]).toEqual(['ses_1']);
      closed.retain(listed());
      expect(closed.getState().size).toBe(0);
      closed.close('ses_2');
      closed.reopen('ses_2');
      expect(closed.getState().size).toBe(0);
    }
  });

  it('before the first Welcome (no workspace) nothing is written', () => {
    const storage = new MemoryStorage();
    createClosedSessions(null, storage).close('ses_1');
    expect(storage.length).toBe(0);
  });
});
