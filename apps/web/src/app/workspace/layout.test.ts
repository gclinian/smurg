// What a browser that ran smurg 0.4.0 still holds in localStorage, handed to this page. The values are the ones the
// 0.4.0 web app really wrote (its own code, run against a storage: v0.4.0 apps/web/src/app/workspace/Workbench.tsx
// 43-78 for `smurg.layout`, ui/SplitPane.tsx for `smurg.pane.<key>`, features/agents/closed-sessions.ts for
// `smurg.agents.closedSessions`), character for character.
import { describe, expect, it } from 'vitest';
import { createRecentWorkspaces } from '../../lib/preferences.ts';
import { MemoryStorage } from '../../testing/services.tsx';
import { carryOldPanelSettings, DEFAULT_LAYOUT, readLayout, writeLayout } from './layout.ts';

/** Every key of the profile 0.4.0 left behind, with every switch away from its 0.4.0 default. */
const PROFILE_040: Readonly<Record<string, string>> = {
  'smurg.recentWorkspaces': '[{"id":"CvBmHPJWyOWAdsmuttOLQQ","name":"test","hostName":"GCman","lastOpenedAt":1759800000000}]',
  'smurg.theme': '"light"',
  'smurg.lang': 'zh-TW',
  'smurg.layout': '{"sidebar":false,"right":false,"drawer":true,"drawerTab":"merge-requests","suggestions":false,"agentsWide":true}',
  'smurg.pane.suggestions': '310',
  'smurg.pane.drawer': '333',
  'smurg.pane.sidebar': '444',
  'smurg.pane.right': '555',
  'smurg.agents.closedSessions': '{"CvBmHPJWyOWAdsmuttOLQQ":["s_0123456789abcdef"]}',
};

function storageWith(values: Readonly<Record<string, string>>): MemoryStorage {
  const storage = new MemoryStorage();
  for (const [key, value] of Object.entries(values)) storage.setItem(key, value);
  return storage;
}

function contents(storage: MemoryStorage): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i) as string;
    out[key] = storage.getItem(key) as string;
  }
  return out;
}

describe('smurg.layout as 0.4.0 wrote it', () => {
  it('the file tree comes from `sidebar`, the session column from `right`, the drawer as it is, the tab that is gone becomes the activity tab', () => {
    const storage = storageWith({ 'smurg.layout': PROFILE_040['smurg.layout'] as string });
    expect(readLayout(storage)).toEqual({ left: true, inbox: true, sessions: true, files: false, side: false, drawer: true, drawerTab: 'activity' });
  });

  it('each switch on its own, and the three tabs that still exist', () => {
    const read = (value: unknown) => readLayout(storageWith({ 'smurg.layout': JSON.stringify(value) }));
    // The other proof's value: the file tree folded, the agents column shown.
    expect(read({ sidebar: false, right: true, drawer: true, drawerTab: 'merge-requests', suggestions: false, agentsWide: true })).toMatchObject({ files: false, side: true, drawer: true, drawerTab: 'activity' });
    // 0.4.0's own default.
    expect(read({ sidebar: true, right: true, drawer: false, drawerTab: 'activity', suggestions: true, agentsWide: false })).toEqual(DEFAULT_LAYOUT);
    expect(read({ sidebar: true, right: false, drawer: false, drawerTab: 'conflicts', suggestions: true, agentsWide: false })).toMatchObject({ files: true, side: false, drawer: false, drawerTab: 'conflicts' });
    expect(read({ sidebar: true, right: true, drawer: true, drawerTab: 'transfers', suggestions: true, agentsWide: false })).toMatchObject({ drawer: true, drawerTab: 'transfers' });
  });

  it('what this version wrote is read as it is: an old name never wins over the name of today', () => {
    const now = { left: false, inbox: false, sessions: true, files: true, side: false, drawer: true, drawerTab: 'terminal' } as const;
    const storage = new MemoryStorage();
    writeLayout(now, storage);
    expect(readLayout(storage)).toEqual(now);
    // A value that holds both (no published version wrote one): today's names decide.
    storage.setItem('smurg.layout', JSON.stringify({ ...now, sidebar: false, right: true }));
    expect(readLayout(storage)).toEqual(now);
  });

  it('stays tolerant: junk of any kind is the default layout, never a throw (the reader runs in a state initializer)', () => {
    for (const raw of ['not json {', 'null', '42', '"text"', '[]', '{"sidebar":"yes","right":7,"drawer":null,"drawerTab":7}']) {
      expect(readLayout(storageWith({ 'smurg.layout': raw })), raw).toEqual(DEFAULT_LAYOUT);
    }
    expect(readLayout(null)).toEqual(DEFAULT_LAYOUT);
  });
});

describe('the panel settings of 0.4.0, carried once when the page starts', () => {
  it('the whole 0.4.0 profile: layout rewritten in the names of today, the agents column width moved, the dead keys removed, nothing else touched', () => {
    const storage = storageWith(PROFILE_040);
    carryOldPanelSettings(storage);
    expect(contents(storage)).toEqual({
      'smurg.recentWorkspaces': PROFILE_040['smurg.recentWorkspaces'],
      'smurg.theme': '"light"',
      'smurg.lang': 'zh-TW',
      'smurg.layout': '{"left":true,"inbox":true,"sessions":true,"files":false,"side":false,"drawer":true,"drawerTab":"activity"}',
      'smurg.pane.drawer': '333',
      'smurg.pane.sidebar': '444',
      'smurg.pane.side': '555',
    });
    // What the other readers hold is what 0.4.0 wrote.
    expect(createRecentWorkspaces(storage).getState()).toEqual([{ id: 'CvBmHPJWyOWAdsmuttOLQQ', name: 'test', hostName: 'GCman', lastOpenedAt: 1_759_800_000_000 }]);
  });

  it('a second start changes nothing', () => {
    const storage = storageWith(PROFILE_040);
    carryOldPanelSettings(storage);
    const once = contents(storage);
    carryOldPanelSettings(storage);
    expect(contents(storage)).toEqual(once);
  });

  it('a width this version already remembers is kept; the old one is removed all the same', () => {
    const storage = storageWith({ 'smurg.pane.right': '555', 'smurg.pane.side': '420' });
    carryOldPanelSettings(storage);
    expect(contents(storage)).toEqual({ 'smurg.pane.side': '420' });
  });

  it('an old width that is not a number is not carried, and is removed', () => {
    for (const raw of ['"wide"', 'null', '{"w":1}', 'not json {']) {
      const storage = storageWith({ 'smurg.pane.right': raw });
      carryOldPanelSettings(storage);
      expect(contents(storage), raw).toEqual({});
    }
  });

  it('a browser that never ran 0.4.0: nothing is written, nothing is removed', () => {
    const now = { 'smurg.layout': '{"left":false,"inbox":true,"sessions":true,"files":true,"side":true,"drawer":false,"drawerTab":"terminal"}', 'smurg.pane.side': '500', 'smurg.pane.sessions-left': '300', 'smurg.theme': '"dark"' };
    const storage = storageWith(now);
    carryOldPanelSettings(storage);
    expect(contents(storage)).toEqual(now);
    const empty = new MemoryStorage();
    carryOldPanelSettings(empty);
    expect(empty.length).toBe(0);
  });

  it('a storage that is blocked or throws: the page starts all the same', () => {
    expect(() => carryOldPanelSettings(null)).not.toThrow();
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => carryOldPanelSettings(broken)).not.toThrow();
    // Reads work, writes do not (a full or read-only storage): nothing is lost, the old values stay for the next start.
    const readOnly = storageWith(PROFILE_040);
    const frozen = {
      getItem: (key: string) => readOnly.getItem(key),
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: (key: string) => readOnly.removeItem(key),
    };
    expect(() => carryOldPanelSettings(frozen)).not.toThrow();
    expect(readOnly.getItem('smurg.pane.right')).toBe('555');
    expect(readOnly.getItem('smurg.layout')).toBe(PROFILE_040['smurg.layout']);
  });
});
